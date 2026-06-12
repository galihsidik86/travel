// Stage 238 — jemaah-side sanitized booking activity timeline.
//
// Distinct from S98 `getBookingActivityFeed` (admin) which exposes
// internal mentions, tasks, notif queue rows, and actor emails. The
// jemaah view shows ONLY events that affect THEM:
//
//   - status transitions (booked → DP → LUNAS / CANCELLED)
//   - payment received / refund issued (humanised)
//   - document verified / rejected (admin's decision they need to act on)
//   - announcement posted (S192)
//   - pickup choice (their own action)
//
// Sanitization rules (privacy + UX):
//   - NO admin emails or roles surfaced
//   - NO internal note content (admins might write candid context)
//   - NO mention/task/notif rows (operational, not user-facing)
//   - Status changes show humanised labels not Prisma enum codes
//   - Refund rows show the structured `refundReasonCode` (S235) IF set —
//     code is shareable category, not internal admin reasoning
//
// Ownership enforced by caller (`/saya/bookings/:id` already runs
// `getMyBooking` which scopes by `jemaahUserId`). This service trusts
// the caller has done that check and just builds the timeline.

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const STATUS_LABELS = {
  PENDING: 'Menunggu pembayaran',
  BOOKED: 'Booking dikonfirmasi',
  DP_PAID: 'DP terbayar',
  PARTIAL: 'Cicilan diterima',
  LUNAS: 'Lunas — siap berangkat',
  CANCELLED: 'Dibatalkan',
  REFUNDED: 'Dana sudah dikembalikan',
};

const DOC_TYPE_LABELS = {
  PASSPORT: 'Paspor',
  VISA_UMROH: 'Visa Umroh',
  MANASIK_CERT: 'Sertifikat Manasik',
  HEALTH_CERT: 'Surat Sehat',
  VACCINE_MENINGITIS: 'Vaksin Meningitis',
  MARRIAGE_CERT: 'Buku Nikah',
  FAMILY_CARD: 'Kartu Keluarga',
  OTHER: 'Dokumen lain',
};

const REFUND_REASON_LABELS = {
  JEMAAH_REQUEST: 'Permintaan jemaah',
  PAKET_CANCELLED: 'Paket dibatalkan',
  VISA_REJECTED: 'Visa ditolak',
  JEMAAH_ILL: 'Kondisi kesehatan',
  DOCUMENT_INCOMPLETE: 'Dokumen tidak lengkap',
  NO_SHOW_REFUND: 'No-show refund',
  GOODWILL: 'Kebijakan goodwill',
  DUPLICATE_PAYMENT: 'Pembayaran dobel',
  FRAUD_CHARGEBACK: 'Chargeback',
  OTHER: 'Lainnya',
};

function fmtIdr(n) {
  return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
}

/**
 * Returns `{rows, total}` sorted newest-first. Each row carries
 * `{kind, label, when, badge?}`. NO actor info, NO internal notes.
 */
export async function getJemaahBookingActivity(bookingId, { limit = 50 } = {}) {
  if (!bookingId) return { rows: [], total: 0 };

  const [audits, payments, docs, announcements] = await Promise.all([
    db.auditLog.findMany({
      where: {
        entity: 'Booking', entityId: bookingId,
        // Filter to jemaah-relevant actions only
        action: { in: ['CREATE', 'STATUS_CHANGE', 'PAYMENT_RECEIVED', 'REFUND_ISSUED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, after: true, createdAt: true },
    }),
    db.payment.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, method: true, status: true, refundReasonCode: true, createdAt: true },
    }),
    // Documents are jemaah-tied not booking-tied; fetch via booking → jemaahId
    (async () => {
      const b = await db.booking.findUnique({ where: { id: bookingId }, select: { jemaahId: true } });
      if (!b) return [];
      return db.jemaahDocument.findMany({
        where: { jemaahId: b.jemaahId, status: { in: ['VERIFIED', 'REJECTED'] } },
        orderBy: { updatedAt: 'desc' },
        take: 30,
        select: { id: true, type: true, status: true, verifiedAt: true, updatedAt: true },
      });
    })(),
    // Paket announcements (S192) — show announcements published while
    // jemaah's booking has been active. Boundary set to booking createdAt.
    (async () => {
      const b = await db.booking.findUnique({
        where: { id: bookingId },
        select: { paketId: true, createdAt: true },
      });
      if (!b) return [];
      return db.paketAnnouncement.findMany({
        where: {
          paketId: b.paketId,
          publishedAt: { gte: b.createdAt },
        },
        orderBy: { publishedAt: 'desc' },
        take: 20,
        select: { id: true, title: true, publishedAt: true },
      });
    })(),
  ]);

  const rows = [];

  // Audit-derived rows — humanised
  for (const a of audits) {
    if (a.action === 'CREATE') {
      rows.push({ kind: 'create', label: 'Booking dibuat', when: a.createdAt });
    } else if (a.action === 'STATUS_CHANGE') {
      const newStatus = a.after?.status;
      const label = newStatus && STATUS_LABELS[newStatus]
        ? STATUS_LABELS[newStatus]
        : 'Status berubah';
      // Skip status changes that only carry note flips / pickup choices / etc
      if (a.after?.cancelRequested) continue; // handled separately if needed
      if (a.after?.pickupChosen || a.after?.adminSet) {
        rows.push({ kind: 'pickup', label: 'Lokasi pickup dipilih', when: a.createdAt });
        continue;
      }
      if (a.after?.tagsChanged) continue; // internal labelling, jemaah doesn't see tags
      if (a.after?.notesPinned !== undefined) continue;
      if (newStatus) {
        rows.push({ kind: 'status', label, when: a.createdAt, badge: newStatus });
      }
    } else if (a.action === 'REFUND_ISSUED') {
      const amt = Math.abs(toNumber(a.after?.refundAmount) ?? 0);
      const code = a.after?.refundReasonCode;
      const codeLabel = code && REFUND_REASON_LABELS[code] ? REFUND_REASON_LABELS[code] : null;
      const label = codeLabel
        ? `Refund ${fmtIdr(amt)} diproses (${codeLabel})`
        : `Refund ${fmtIdr(amt)} diproses`;
      rows.push({ kind: 'refund', label, when: a.createdAt, badge: 'REFUND' });
    }
  }

  // Payment-derived rows (only PAID rows, refund handled via audit above)
  for (const p of payments) {
    if (p.status !== 'PAID') continue;
    const amt = toNumber(p.amount) ?? 0;
    rows.push({
      kind: 'payment',
      label: `Pembayaran ${fmtIdr(amt)} diterima via ${p.method}`,
      when: p.paidAt || p.createdAt,
      badge: 'PAID',
    });
  }

  // Doc verification — VERIFIED is the helpful signal; REJECTED is a
  // call-to-action so we surface it too with amber framing.
  for (const d of docs) {
    const t = DOC_TYPE_LABELS[d.type] || d.type;
    if (d.status === 'VERIFIED') {
      rows.push({
        kind: 'doc',
        label: `${t} terverifikasi`,
        when: d.verifiedAt || d.updatedAt,
        badge: 'VERIFIED',
      });
    } else if (d.status === 'REJECTED') {
      rows.push({
        kind: 'doc',
        label: `${t} ditolak — silakan upload ulang`,
        when: d.updatedAt,
        badge: 'REJECTED',
      });
    }
  }

  // Announcements
  for (const a of announcements) {
    rows.push({
      kind: 'announcement',
      label: `📢 ${a.title}`,
      when: a.publishedAt,
      badge: 'INFO',
    });
  }

  rows.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
  const bounded = rows.slice(0, limit);
  return { rows: bounded, total: rows.length };
}
