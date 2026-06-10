// Stage 172 — daily reminder to jemaah with unpaid balance on
// bookings whose paket departs soon. Per-booking cooldown via the
// existing Notification table so jemaah don't get the same nudge
// every single day until takeoff.
//
// Targets:
//   - status IN (PENDING, BOOKED, DP_PAID, PARTIAL) — LUNAS bookings
//     don't owe anything; CANCELLED/REFUNDED are dead.
//   - paket.departureDate within `windowDays` (default 14).
//   - paidAmount < totalAmount (unpaid balance > 0).
//   - bookings without a PAYMENT_REMINDER notif in the last
//     `cooldownDays` (default 5).
//
// Silent on empty candidate list. Per-booking failure isolated so
// one bad row doesn't abort the batch.

import { db } from '../lib/db.js';

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_COOLDOWN_DAYS = 5;

export async function getPaymentReminderCandidates({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60_000);
  const cooldownCutoff = new Date(now.getTime() - cooldownDays * 24 * 60 * 60_000);

  // Pull active bookings whose paket departs in window. We filter
  // unpaid balance in JS since Prisma's `where` doesn't let us
  // compare two columns directly without raw SQL.
  const bookings = await db.booking.findMany({
    where: {
      status: { in: ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL'] },
      paket: {
        departureDate: { gte: now, lte: windowEnd },
        deletedAt: null,
      },
    },
    select: {
      id: true, bookingNo: true, status: true,
      totalAmount: true, paidAmount: true,
      kelas: true, paxCount: true,
      jemaahUserId: true,
      paket: { select: { slug: true, title: true, departureDate: true } },
      jemaah: {
        select: {
          id: true, fullName: true, phone: true,
          user: { select: { id: true, email: true } },
        },
      },
    },
  });

  // Skip when balance is zero or negative (already paid in full —
  // status hasn't caught up yet, defensive).
  const unpaid = bookings.filter((b) => {
    const total = Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
    const paid = Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0;
    return total > paid;
  });
  if (unpaid.length === 0) return { rows: [], windowDays, cooldownDays };

  // Per-booking cooldown — check for any PAYMENT_REMINDER notif on
  // these bookings within cooldownCutoff window.
  const ids = unpaid.map((b) => b.id);
  const recent = await db.notification.findMany({
    where: {
      type: 'PAYMENT_REMINDER',
      relatedEntity: 'Booking',
      relatedEntityId: { in: ids },
      createdAt: { gte: cooldownCutoff },
    },
    select: { relatedEntityId: true },
  });
  const recentlyNudged = new Set(recent.map((n) => n.relatedEntityId));

  const rows = unpaid.filter((b) => !recentlyNudged.has(b.id));
  // Sort soonest-departing first — most urgent at top of any queue
  rows.sort((a, b) => a.paket.departureDate.getTime() - b.paket.departureDate.getTime());
  return { rows, windowDays, cooldownDays };
}

export async function sendPaymentReminders({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const { rows } = await getPaymentReminderCandidates({ now, windowDays, cooldownDays });
  if (rows.length === 0) {
    return { bookingCount: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  const { notifyPaymentReminder } = await import('./notifications.js');
  let enqueued = 0, skipped = 0, errors = 0;
  for (const b of rows) {
    try {
      const total = Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
      const paid = Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0;
      const outstanding = total - paid;
      const daysUntil = Math.max(0, Math.ceil(
        (b.paket.departureDate.getTime() - now.getTime()) / (24 * 60 * 60_000),
      ));
      const r = await notifyPaymentReminder({
        booking: b, outstanding, daysUntil,
      });
      if (r.enqueued) enqueued += r.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[payment-reminder] booking ${b.bookingNo} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { bookingCount: rows.length, enqueued, skipped, errors };
}

export { DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS };
