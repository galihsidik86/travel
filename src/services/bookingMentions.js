// Stage 86 — per-user mention history.
//
// Reads BookingMention rows for the given user, ordered newest first, with
// the linked booking + jemaah + paket so the panel renders one click away
// from the bookings the viewer was tagged into.
//
// `userEmail` is the lookup key (not userId) — matches the data S81 +
// notifyBookingNoteMention stamp at insert time. A user changing their
// email later is rare enough that a missed handful of rows isn't worth
// the join complexity.
import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getMyMentions({ userEmail, days = 30, limit = 20 } = {}) {
  if (!userEmail) return { rows: [], totals: { count: 0 }, windowDays: days };

  const start = new Date(Date.now() - days * ONE_DAY_MS);
  const rows = await db.bookingMention.findMany({
    where: {
      userEmail,
      createdAt: { gte: start },
      // Hide rows whose booking has been soft-deleted or fully removed
      // (cascade keeps history accurate when intentional deletes happen).
      booking: { is: {} },
    },
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, createdAt: true,
      mentionedByEmail: true,
      booking: {
        select: {
          id: true, bookingNo: true, status: true,
          jemaah: { select: { fullName: true } },
          paket: { select: { title: true, slug: true } },
        },
      },
    },
  });

  // Count of all mentions in window (irrespective of `limit`) — admin
  // sees "12 mentions this 30d, top 20 shown".
  const totalCount = await db.bookingMention.count({
    where: { userEmail, createdAt: { gte: start } },
  });

  return {
    rows,
    totals: { count: totalCount, shown: rows.length },
    windowDays: days,
  };
}
