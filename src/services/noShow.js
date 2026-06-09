// Stage 144 — no-show detection.
//
// "Jemaah paid + booked + the trip departed without them showing up."
// Detected via: active booking + paket departure passed + ZERO
// AttendanceMark for day 1 of the itinerary. Catches the failure mode
// where crew marked everyone present (good) AND the no-show is
// genuinely absent from day 1 (real signal, not a missing form).
//
// Once stamped, `Booking.noShowAt` blocks re-detection (idempotent
// across daily cron passes). Admin can clear the field manually if a
// late attendance correction reverses the verdict.
//
// **Not** considered no-show:
//   - Bookings already CANCELLED / REFUNDED — irrelevant to the trip
//   - Bookings where the paket has NO itinerary day 1 (admin hasn't
//     set up the schedule yet) — we'd be guessing
//   - Bookings where ANY attendance mark exists for day 1 (present OR
//     absent — both are real signals that the crew was tracking them)

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

const ACTIVE_BOOKING_STATES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS'];

/**
 * Stage 144 — find + stamp no-shows. Returns counters for the cron
 * report. Pass `dryRun:true` to compute the list without writing.
 */
export async function detectNoShows({
  now = new Date(), dryRun = false, req = null, actor = null,
} = {}) {
  // Active bookings on paket whose departure has passed AND that don't
  // already carry a noShowAt stamp. Active includes LUNAS — a paid
  // jemaah who never showed up is the most important kind to surface.
  const candidates = await db.booking.findMany({
    where: {
      noShowAt: null,
      status: { in: ACTIVE_BOOKING_STATES },
      paket: {
        deletedAt: null,
        departureDate: { lt: now },
      },
    },
    select: {
      id: true, bookingNo: true, status: true,
      paket: {
        select: {
          id: true, slug: true, title: true, departureDate: true,
          days: {
            where: { dayNumber: 1 },
            select: { id: true },
          },
        },
      },
      jemaah: { select: { fullName: true, phone: true } },
    },
  });

  // Filter to bookings where paket actually has a day 1 AND no
  // attendance mark exists for that day. The where-clause above
  // can't express "no related row in another table" cleanly without
  // a subquery, so we batch-check in JS — cheap because the candidate
  // list is bounded by paket-departed-and-not-stamped.
  const interesting = [];
  for (const b of candidates) {
    const day1 = b.paket?.days?.[0];
    if (!day1) continue;  // paket without itinerary — skip
    const markCount = await db.attendanceMark.count({
      where: { bookingId: b.id, paketDayId: day1.id },
    });
    if (markCount > 0) continue;  // any mark = not a no-show
    interesting.push({ booking: b, day1Id: day1.id });
  }

  if (dryRun) {
    return { found: interesting.length, marked: 0, candidates: interesting };
  }

  let marked = 0;
  for (const row of interesting) {
    try {
      await db.booking.update({
        where: { id: row.booking.id },
        data: { noShowAt: now },
      });
      // Per-row audit so admin can see WHEN the system flipped a
      // particular booking. Actor defaults to system.
      await audit({
        req: req ?? null,
        actor: actor ?? { email: 'system' },
        action: 'STATUS_CHANGE', entity: 'Booking',
        entityId: row.booking.id,
        before: { noShowAt: null },
        after: {
          noShowAt: now.toISOString(),
          trigger: 'noshow.daily_detection',
          paketSlug: row.booking.paket.slug,
        },
      }).catch((err) => console.warn('[noshow] audit failed:', err?.message || err));
      marked += 1;
    } catch (err) {
      console.warn('[noshow] stamp failed:', err?.message || err);
    }
  }
  return { found: interesting.length, marked };
}

/**
 * Stage 144 — admin queue list. Returns no-show bookings ordered by
 * most-recent-stamp first. Paginated since over time this grows.
 */
export async function listNoShows({ page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const [total, rows] = await Promise.all([
    db.booking.count({ where: { noShowAt: { not: null } } }),
    db.booking.findMany({
      where: { noShowAt: { not: null } },
      take: pageSize,
      skip: (safePage - 1) * pageSize,
      orderBy: { noShowAt: 'desc' },
      select: {
        id: true, bookingNo: true, status: true, kelas: true, paxCount: true,
        totalAmount: true, paidAmount: true,
        noShowAt: true,
        jemaah: { select: { fullName: true, phone: true, email: true } },
        paket: {
          select: { slug: true, title: true, departureDate: true, returnDate: true },
        },
        agent: { select: { slug: true, displayName: true } },
      },
    }),
  ]);
  return {
    rows, total,
    page: safePage, pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
