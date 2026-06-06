// Stage 26 — paket waitlist service.
//
// Public flow:
//   /p/<slug> form auto-flips CTA when kursi penuh → POST /api/waitlist.
//   `joinWaitlist({paketSlug, fullName, phone, notes})` upserts a row
//   keyed on (paketId, phone) so the same jemaah re-submitting on the
//   same paket just refreshes their entry instead of duplicating.
//
// Admin flow:
//   `listWaitlist(paketSlug)` returns rows split by status.
//   `promoteWaitlist({id, kelas, paxCount, agentSlug, actor, req})` creates
//   a Booking via the existing createBooking pipeline (same money math,
//   audit trail) + flips the waitlist row to PROMOTED with a backref.
//   Reuses createBooking so admin-walk-in / agen-link / public-form all
//   converge on the same money/komisi/notif behaviour.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { createBooking } from './booking.js';

const JoinSchema = z.object({
  fullName: z.string().trim().min(2, 'Nama minimal 2 karakter').max(190),
  phone: z.string().trim().min(8, 'Telepon minimal 8 karakter').max(30),
  notes: z.preprocess(
    (v) => (v == null || String(v).trim() === '' ? null : String(v)),
    z.string().max(2000).nullable().optional(),
  ),
});

async function loadActivePaket(slug) {
  const p = await db.paket.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, title: true,
      kursiTotal: true, kursiTerisi: true, status: true, deletedAt: true,
    },
  });
  if (!p || p.deletedAt) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  return p;
}

export function isFullPaket(paket) {
  return paket.kursiTerisi >= paket.kursiTotal;
}

/**
 * Public sign-up. Upserts on (paketId, phone) so refreshing the form
 * doesn't pile up duplicate rows. Refuses if kursi is NOT yet full —
 * waitlist is a "last resort" UI only.
 */
export async function joinWaitlist({ req, paketSlug, input }) {
  const parsed = JoinSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input tidak valid', 'BAD_INPUT');
  }
  const paket = await loadActivePaket(paketSlug);
  if (!isFullPaket(paket)) {
    throw new HttpError(409, 'Paket masih ada kursi — silakan booking langsung', 'PAKET_NOT_FULL');
  }
  if (paket.status === 'ARCHIVED' || paket.status === 'CLOSED') {
    throw new HttpError(409, 'Paket sudah ditutup', 'PAKET_CLOSED');
  }

  const data = parsed.data;
  const row = await db.paketWaitlist.upsert({
    where: { paketId_phone: { paketId: paket.id, phone: data.phone } },
    create: {
      paketId: paket.id,
      fullName: data.fullName, phone: data.phone,
      notes: data.notes ?? null,
      status: 'WAITING',
    },
    update: {
      // If a previously CANCELLED row exists, joining again reopens it.
      // Same for a PROMOTED row — shouldn't happen UI-side but be defensive.
      status: 'WAITING',
      fullName: data.fullName,
      notes: data.notes ?? null,
      cancelledAt: null,
    },
  });

  await audit({
    req, actor: { email: 'public', role: null },
    action: 'CREATE', entity: 'PaketWaitlist', entityId: row.id,
    after: { paketSlug, fullName: data.fullName, phone: data.phone },
  });

  return { waitlist: row, paket };
}

export async function listWaitlist(paketSlug) {
  const paket = await loadActivePaket(paketSlug);
  const rows = await db.paketWaitlist.findMany({
    where: { paketId: paket.id },
    orderBy: { createdAt: 'asc' },
  });
  const counts = { waiting: 0, promoted: 0, cancelled: 0 };
  for (const r of rows) {
    if (r.status === 'WAITING')   counts.waiting++;
    else if (r.status === 'PROMOTED') counts.promoted++;
    else if (r.status === 'CANCELLED') counts.cancelled++;
  }
  return { paket, rows, counts };
}

/**
 * Promote a waitlist row to a real Booking. Uses the existing
 * createBooking flow so money math, komisi, and notifs all converge on
 * the canonical path.
 *
 * Refuses if the row is not WAITING (already promoted / cancelled).
 * Refuses if kursi is now full again (handle pathologically — admin
 * can manually cancel + re-promote a different row in that case).
 */
export async function promoteWaitlist({ req, actor, id, kelas, paxCount, agentSlug = null }) {
  const row = await db.paketWaitlist.findUnique({
    where: { id },
    include: { paket: { select: { id: true, slug: true, kursiTotal: true, kursiTerisi: true, status: true, deletedAt: true } } },
  });
  if (!row) throw new HttpError(404, 'Waitlist tidak ditemukan', 'WAITLIST_NOT_FOUND');
  if (row.status !== 'WAITING') {
    throw new HttpError(409, `Sudah ${row.status.toLowerCase()}, tidak bisa di-promote lagi`, 'NOT_WAITING');
  }
  if (!row.paket || row.paket.deletedAt) {
    throw new HttpError(404, 'Paket sudah tidak aktif', 'PAKET_NOT_FOUND');
  }

  // createBooking enforces its own kursi check, so re-checking here is
  // for the friendly error message.
  if (row.paket.kursiTerisi >= row.paket.kursiTotal) {
    throw new HttpError(409, 'Kursi sudah penuh lagi — cancel dulu booking lain', 'PAKET_FULL');
  }

  const result = await createBooking({
    req,
    paketSlug: row.paket.slug,
    agentSlug,
    fullName: row.fullName,
    phone: row.phone,
    kelas,
    paxCount,
    notes: row.notes ? `[waitlist promote] ${row.notes}` : '[waitlist promote]',
    adminCreator: actor,
  });

  const updated = await db.paketWaitlist.update({
    where: { id },
    data: {
      status: 'PROMOTED',
      promotedAt: new Date(),
      promotedBookingId: result.booking.id,
    },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'PaketWaitlist', entityId: id,
    before: { status: 'WAITING' },
    after: { status: 'PROMOTED', bookingId: result.booking.id, bookingNo: result.booking.bookingNo },
  });

  return { booking: result.booking, waitlist: updated };
}

export async function cancelWaitlist({ req, actor, id }) {
  const row = await db.paketWaitlist.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'Waitlist tidak ditemukan', 'WAITLIST_NOT_FOUND');
  if (row.status === 'PROMOTED') {
    throw new HttpError(409, 'Sudah di-promote, tidak bisa di-cancel', 'ALREADY_PROMOTED');
  }
  const updated = await db.paketWaitlist.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'PaketWaitlist', entityId: id,
    before: { status: row.status },
    after: { status: 'CANCELLED' },
  });
  return updated;
}
