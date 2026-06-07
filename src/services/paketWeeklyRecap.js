// Stage 32 — per-paket 7-day activity recap. Answers "what happened on
// THIS paket in the last week?" — useful when an admin is reviewing a
// specific manifest before a manasik / coordination call.
//
// Sources are the same that the global digest reads (Booking, Payment,
// JemaahDocument, Komisi), filtered to one paketId. Idempotent: same
// 7-day window gives identical numbers regardless of when called within
// the day (window granularity is calendar-day-aligned).

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const ONE_DAY_MS = 86_400_000;

/**
 * Resolve a 7-day window ending at start-of-today (so the window covers
 * the previous 7 *complete* calendar days; today-so-far is intentionally
 * excluded for stability — a recap that flickers as the day progresses
 * is misleading).
 */
function resolveWeekWindow(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * ONE_DAY_MS);
  return { start, end };
}

export async function getPaketWeeklyRecap({ slug, now = new Date() } = {}) {
  if (!slug) return null;
  const paket = await db.paket.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, title: true, status: true,
      kursiTotal: true, kursiTerisi: true,
      departureDate: true, durationDays: true,
      deletedAt: true,
    },
  });
  if (!paket || paket.deletedAt) return null;

  const { start, end } = resolveWeekWindow(now);

  const [
    newBookings,
    lunasBookings,
    payments,
    refunds,
    docsVerified,
    cancelledBookings,
  ] = await Promise.all([
    db.booking.findMany({
      where: { paketId: paket.id, createdAt: { gte: start, lt: end } },
      select: {
        id: true, bookingNo: true, status: true, totalAmount: true,
        createdAt: true,
        jemaah: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.booking.count({
      where: { paketId: paket.id, status: 'LUNAS', updatedAt: { gte: start, lt: end } },
    }),
    db.payment.findMany({
      where: {
        status: 'PAID', paidAt: { gte: start, lt: end },
        booking: { paketId: paket.id },
      },
      select: { amount: true, currency: true },
    }),
    db.payment.findMany({
      where: {
        status: 'REFUNDED', createdAt: { gte: start, lt: end },
        booking: { paketId: paket.id },
      },
      select: { amount: true },
    }),
    db.jemaahDocument.count({
      where: {
        status: 'VERIFIED',
        verifiedAt: { gte: start, lt: end },
        jemaah: { bookings: { some: { paketId: paket.id } } },
      },
    }),
    db.booking.count({
      where: {
        paketId: paket.id, status: 'CANCELLED',
        cancelledAt: { gte: start, lt: end },
      },
    }),
  ]);

  // Currency aggregation — IDR only (the digest's same rule: mixing
  // currencies makes the summary harder to read than helpful).
  const paymentsInIdr = payments
    .filter((p) => (p.currency || 'IDR') === 'IDR')
    .reduce((acc, p) => acc + (toNumber(p.amount) ?? 0), 0);
  const refundsOutIdr = refunds
    .reduce((acc, p) => acc + Math.abs(toNumber(p.amount) ?? 0), 0);

  const newRevenue = newBookings.reduce(
    (acc, b) => acc + (toNumber(b.totalAmount) ?? 0),
    0,
  );

  return {
    paket,
    window: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      days: 7,
    },
    counts: {
      newBookings: newBookings.length,
      lunasBookings,
      docsVerified,
      cancelledBookings,
    },
    money: {
      newRevenueIdr: newRevenue,
      paymentsInIdr,
      refundsOutIdr,
      netRevenueIdr: paymentsInIdr - refundsOutIdr,
    },
    // Latest 5 new bookings shown inline — admin can spot-check identity
    // without leaving the overview.
    recentNewBookings: newBookings.slice(0, 5),
  };
}
