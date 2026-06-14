// Stage 289 — public inquiry from /p/:slug. Pre-lead capture for
// visitors who aren't ready to book.
//
// Friction-free: no account, no booking, just name + phone + optional
// message. Admin reviews in the queue + can convert to a Lead under
// a chosen agent (S290).
//
// Phone normalization mirrors the lead-dup convention (S167/S209) —
// strip non-digits, leading 0 → 62 — so dedup checks work across format
// variants.
//
// Rate-limit middleware (S2) is applied at the route layer, not here.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const MAX_MESSAGE = 2000;

function clean(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function normalisePhone(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

/**
 * Public submit. Captures the inquiry; sends an admin notif so
 * someone reviews quickly (S290 conversion happens manually).
 */
export async function submitPublicInquiry({ req, input }) {
  const fullName = clean(input?.fullName, 190);
  const phone = clean(input?.phone, 30);
  const message = clean(input?.message, MAX_MESSAGE);
  const email = clean(input?.email, 190);
  const paketSlug = clean(input?.paketSlug, 190);
  const agentSlug = clean(input?.agentSlug, 190);

  if (!fullName || fullName.length < 2) {
    throw new HttpError(400, 'Nama wajib (min. 2 karakter)', 'INQUIRY_NAME_REQUIRED');
  }
  if (!phone || normalisePhone(phone).length < 8) {
    throw new HttpError(400, 'Telepon/WA wajib (min. 8 digit)', 'INQUIRY_PHONE_REQUIRED');
  }

  // Light dedup: same phone within last 10 min — don't spam admin
  // queue with double-submits from accidental form re-submission.
  const recentCutoff = new Date(Date.now() - 10 * 60_000);
  const normPhone = normalisePhone(phone);
  // Pre-filter by ending — endsWith on the last 8 digits captures format variants.
  const tail = normPhone.slice(-8);
  if (tail.length >= 8) {
    const recent = await db.publicInquiry.findFirst({
      where: {
        phone: { endsWith: tail },
        createdAt: { gte: recentCutoff },
        // Same paket too (admin can re-submit on a different paket page)
        paketSlug: paketSlug || null,
      },
      select: { id: true },
    });
    if (recent) {
      // Idempotent: return the existing row instead of creating a duplicate.
      return { inquiry: await db.publicInquiry.findUnique({ where: { id: recent.id } }), idempotent: true };
    }
  }

  const ip = req?.ip || req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() || null;
  const userAgent = req?.headers?.['user-agent']?.slice(0, 1000) || null;

  const inquiry = await db.publicInquiry.create({
    data: {
      paketSlug, agentSlug,
      fullName, phone, email, message,
      ip, userAgent,
    },
  });

  // Best-effort admin fan-out so reviews don't lag. GENERIC notif (no
  // dedicated enum — inquiries are admin-side; reusing GENERIC keeps
  // notif type list lean).
  try {
    const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
    const admins = await db.user.findMany({
      where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
      select: { email: true },
    });
    if (admins.length > 0) {
      const { enqueueNotification } = await import('./notifications.js');
      const subject = `[Inquiry] ${fullName}${paketSlug ? ' · ' + paketSlug : ''}`;
      const body = [
        `Inquiry baru dari ${fullName}`,
        `Telepon: ${phone}`,
        email ? `Email: ${email}` : null,
        paketSlug ? `Paket: ${paketSlug}` : null,
        agentSlug ? `Agen referral: ${agentSlug}` : null,
        '',
        message ? `Pesan: ${message}` : '(tidak ada pesan)',
        '',
        'Review + convert di /admin/inquiries',
      ].filter(Boolean).join('\n');
      for (const a of admins) {
        try {
          await enqueueNotification({
            type: 'GENERIC', channel: 'EMAIL',
            recipientEmail: a.email,
            subject, body,
            payload: { kind: 'public_inquiry_new', inquiryId: inquiry.id, paketSlug, agentSlug },
            relatedEntity: 'PublicInquiry', relatedEntityId: inquiry.id,
          });
        } catch (err) {
          console.warn('[submitPublicInquiry] admin notif failed:', err?.message || err);
        }
      }
    }
  } catch (err) {
    console.warn('[submitPublicInquiry] notif loop failed:', err?.message || err);
  }

  return { inquiry, idempotent: false };
}

/**
 * Paginated list for the admin queue. Filters by status.
 */
export async function listInquiries({ status = null, page = 1, pageSize = 30 } = {}) {
  const skip = (Math.max(1, page) - 1) * pageSize;
  const take = Math.max(1, Math.min(100, pageSize));
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    db.publicInquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip, take,
    }),
    db.publicInquiry.count({ where }),
  ]);
  return { rows, total, page: Math.max(1, page), pageSize: take };
}

export { normalisePhone };
