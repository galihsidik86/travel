// Stage 237 — auto-cancel stale unpaid PENDING bookings. Daily cron
// walks PENDING bookings older than `staleDays` (default 14) with
// `paidAmount = 0` and flips them to CANCELLED via `cancelBooking` so
// the existing pipeline handles kursi release + komisi + audit.
//
// Why a separate cron (not just rely on admin chase): seats locked
// by speculative bookings hurt conversion. Auto-cancel frees them
// without admin intervention so future jemaah see real availability.
//
// Sanity guards:
//   - PENDING only (BOOKED/DP_PAID/etc. have already paid something)
//   - paidAmount = 0 (any payment means active engagement)
//   - createdAt < cutoff (give jemaah time to pay)
//   - paket departureDate must still be in the future (no point auto-
//     cancelling a booking on a paket that already departed; that's
//     S144 no-show territory)
//   - paket not ARCHIVED / soft-deleted
//
// Skip-when-empty: silent on quiet days.

import { db } from '../lib/db.js';

const DEFAULT_STALE_DAYS = 14;
const DEFAULT_REASON_TEMPLATE = 'Auto-cancel: tidak ada pembayaran setelah {{days}} hari.';

export async function getStalePendingCandidates({
  now = new Date(),
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  const cutoff = new Date(now.getTime() - staleDays * 24 * 60 * 60_000);
  return db.booking.findMany({
    where: {
      status: 'PENDING',
      paidAmount: 0,
      createdAt: { lt: cutoff },
      paket: {
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        departureDate: { gt: now },
      },
    },
    select: {
      id: true, bookingNo: true, paxCount: true, createdAt: true,
      paket: { select: { slug: true, title: true } },
    },
  });
}

export async function runAutoCancelStalePending({
  now = new Date(),
  staleDays = DEFAULT_STALE_DAYS,
  limit = 200,
} = {}) {
  const candidates = await getStalePendingCandidates({ now, staleDays });
  if (candidates.length === 0) {
    return { candidates: 0, cancelled: 0, failed: 0 };
  }
  const bounded = candidates.slice(0, limit);
  const { cancelBooking } = await import('./bookingAdmin.js');
  const actor = { id: null, email: 'system', role: null };
  const req = { ip: null, headers: {}, get: () => null };
  let cancelled = 0;
  let failed = 0;
  for (const c of bounded) {
    try {
      await cancelBooking({
        req, actor,
        bookingId: c.id,
        reason: DEFAULT_REASON_TEMPLATE.replace('{{days}}', String(staleDays)),
        reasonCode: 'PAYMENT_NOT_RECEIVED',
      });
      cancelled += 1;
    } catch (err) {
      console.warn(`[autoCancelStalePending] ${c.bookingNo} failed:`, err?.message || err);
      failed += 1;
    }
  }
  return { candidates: candidates.length, cancelled, failed };
}

export { DEFAULT_STALE_DAYS };
