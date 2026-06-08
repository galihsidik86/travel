// Stage 40 — per-paket booking forecast. Given booking velocity over the
// last 14 days, project when each paket will hit kursi penuh.
//
// Velocity = mean(daily new-booking count) over a 14-day window.
// Days-to-full = remaining kursi / velocity, rounded to the nearest day.
// Confidence band = ±1 standard deviation of daily counts → low SD means
// tighter projection, high SD means the forecast is shakier and the band
// is wide. We surface the band as `dtfLowDays` / `dtfHighDays` so the UI
// can render a range, not a false-precise single number.
//
// Excluded:
//   - Paket already full (kursiTerisi >= kursiTotal) — forecast is "0 days"
//     by definition; show "PENUH" badge instead.
//   - Paket with zero recent activity → velocity=0 → days-to-full=infinity.
//     We mark these `noVelocity:true` and let the UI render "—" rather
//     than divide-by-zero.
//   - Paket whose departureDate is past — forecast is meaningless. Filter
//     them out at the query level.

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;

function localMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Bucket bookings by local-date YYYY-MM-DD so days with zero traffic
 * still appear as zero (mean would otherwise be artificially inflated
 * by skipping empty days).
 */
function bucketByDay(bookings, windowStart, days) {
  const counts = new Array(days).fill(0);
  for (const b of bookings) {
    const idx = Math.floor((b.createdAt.getTime() - windowStart.getTime()) / ONE_DAY_MS);
    if (idx >= 0 && idx < days) counts[idx] += 1;
  }
  return counts;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, x) => a + x, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, x) => a + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Build a forecast row per ACTIVE paket. Returns an array sorted by
 * dtfDays ascending — the most urgent paket (closest to full) lands first.
 *
 * Failure posture is the same as other dashboard services: a paket-level
 * error doesn't abort the whole batch (the bookings query is single,
 * so most failure modes are upstream — DB outage, etc.).
 */
export async function getPaketForecasts({ now = new Date(), days = WINDOW_DAYS } = {}) {
  const windowEnd = localMidnight(now);
  windowEnd.setTime(windowEnd.getTime() + ONE_DAY_MS); // include today
  const windowStart = new Date(windowEnd.getTime() - days * ONE_DAY_MS);

  // ACTIVE + future-departure paket only — past trips have no forecast meaning.
  const today = localMidnight(now);
  const paket = await db.paket.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      departureDate: { gte: today },
    },
    select: {
      id: true, slug: true, title: true,
      kursiTotal: true, kursiTerisi: true,
      departureDate: true,
    },
  });
  if (paket.length === 0) return [];

  const paketIds = paket.map((p) => p.id);
  // Single batched query — all bookings in window for these paket. Includes
  // CANCELLED rows because the *intent to book* still represents demand
  // (cancellation just means one didn't stick — keeping it in velocity
  // would over-promise; excluding it under-promises). The right call is
  // exclude — the row that cancelled doesn't take a seat, so it shouldn't
  // count toward seats-per-day.
  const bookings = await db.booking.findMany({
    where: {
      paketId: { in: paketIds },
      createdAt: { gte: windowStart, lt: windowEnd },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: { paketId: true, createdAt: true },
  });

  const byPaket = new Map();
  for (const b of bookings) {
    const list = byPaket.get(b.paketId) || [];
    list.push(b);
    byPaket.set(b.paketId, list);
  }

  const rows = paket.map((p) => {
    const seatsRemaining = Math.max(0, p.kursiTotal - p.kursiTerisi);
    const daysToDeparture = Math.max(
      0,
      Math.floor((p.departureDate.getTime() - today.getTime()) / ONE_DAY_MS),
    );

    const list = byPaket.get(p.id) || [];
    const counts = bucketByDay(list, windowStart, days);
    const velocity = mean(counts);            // bookings/day, mean
    const sd = stddev(counts);                // bookings/day, stddev
    const totalRecent = list.length;          // total in window

    // Edge cases first
    if (seatsRemaining === 0) {
      return {
        paket: p, seatsRemaining, daysToDeparture,
        velocity, sd, totalRecent,
        windowDays: days,
        full: true, dtfDays: 0, dtfLowDays: 0, dtfHighDays: 0, noVelocity: false,
      };
    }
    if (velocity === 0) {
      return {
        paket: p, seatsRemaining, daysToDeparture,
        velocity, sd, totalRecent,
        windowDays: days,
        full: false, dtfDays: null, dtfLowDays: null, dtfHighDays: null, noVelocity: true,
      };
    }
    // Mean projection
    const dtfDays = Math.ceil(seatsRemaining / velocity);
    // Confidence band — ±1 SD, clamped so the *fast* bound never goes
    // negative and the *slow* bound never goes below the mean.
    const fastVelocity = velocity + sd;   // optimistic side
    const slowVelocity = Math.max(0.01, velocity - sd); // never < epsilon
    const dtfLowDays = Math.ceil(seatsRemaining / fastVelocity);
    const dtfHighDays = Math.ceil(seatsRemaining / slowVelocity);

    return {
      paket: p, seatsRemaining, daysToDeparture,
      velocity, sd, totalRecent,
      windowDays: days,
      full: false,
      dtfDays, dtfLowDays, dtfHighDays,
      noVelocity: false,
      // "Will it fill before departure?" — useful as a status tag.
      risk: dtfDays > daysToDeparture ? 'short' : 'on-track',
    };
  });

  // Sort: most urgent first (lowest dtfDays). PENUH at top (dtfDays=0),
  // then forecastable rows in dtf order, no-velocity rows at the bottom.
  rows.sort((a, b) => {
    if (a.noVelocity && !b.noVelocity) return 1;
    if (b.noVelocity && !a.noVelocity) return -1;
    return (a.dtfDays ?? 1e9) - (b.dtfDays ?? 1e9);
  });

  return rows;
}
