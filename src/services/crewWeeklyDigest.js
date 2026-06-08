// Stage 65 — per-crew (MUTHAWWIF) weekly recap. Monday ~07:20 — after
// the OWNER + AGENT weeklies + payout reminder. Reports the previous
// Mon-Sun's attendance activity for one crew + their upcoming paket
// assignments so they can prep (manifest review, doc check, etc.).
//
// "Activity" we surface:
//   - attendanceMarksCount   total marks made last week
//   - presentCount + absentCount split
//   - paketTouchedCount      how many different paket they marked
//   - upcomingPaket          assigned paket departing in next 30 days
//                            (so crew can prep ahead — passport check,
//                            jemaah contact, room assignments)

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveLastFullWeek(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const thisMon = new Date(today.getTime() - dow * ONE_DAY_MS);
  const start = new Date(thisMon.getTime() - ONE_WEEK_MS);
  const end = new Date(thisMon.getTime());
  const dStart = start.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const lastDayInclusive = new Date(end.getTime() - ONE_DAY_MS);
  const dEnd = lastDayInclusive.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  return { start, end, label: `${dStart} – ${dEnd}` };
}

/**
 * Stage 67 — per-key delta with crew-relevant polarity.
 *   - attendanceMarksCount, presentCount, paketTouchedCount: ↑ better
 *   - absentCount: ↓ better (reverse)
 */
const REVERSE_POLARITY_CREW = new Set(['absentCount']);
function computeCrewDelta(metricKey, current, previous) {
  const diff = current - previous;
  const reverse = REVERSE_POLARITY_CREW.has(metricKey);
  let direction = 'flat';
  if (diff > 0) direction = 'up';
  else if (diff < 0) direction = 'down';
  let good = null;
  if (direction === 'up') good = !reverse;
  else if (direction === 'down') good = reverse;
  const empty = current === 0 && previous === 0;
  let pct = null;
  if (previous !== 0) pct = Math.round((diff / previous) * 100);
  return { diff, pct, direction, good, empty };
}

async function aggregateCrewWeek({ userId, start, end }) {
  const marks = await db.attendanceMark.findMany({
    where: { markedByUserId: userId, markedAt: { gte: start, lt: end } },
    select: { present: true, paketDay: { select: { paketId: true } } },
  });
  const presentCount = marks.filter((m) => m.present).length;
  return {
    attendanceMarksCount: marks.length,
    presentCount,
    absentCount: marks.length - presentCount,
    paketTouchedCount: new Set(marks.map((m) => m.paketDay?.paketId).filter(Boolean)).size,
  };
}

export async function buildCrewWeeklyDigest({ userId, now = new Date() } = {}) {
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, fullName: true, email: true, role: true, status: true, deletedAt: true,
    },
  });
  if (!user || user.role !== 'MUTHAWWIF' || user.status !== 'ACTIVE' || user.deletedAt) return null;

  const last = resolveLastFullWeek(now);
  const prevStart = new Date(last.start.getTime() - ONE_WEEK_MS);
  const prevEnd = new Date(last.start.getTime());
  // 30-day upcoming window from today midnight
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const upcomingEnd = new Date(today.getTime() + 30 * ONE_DAY_MS);

  // Stage 67 — fetch current + previous week aggregates in parallel for
  // delta computation. assignments query still runs in parallel too.
  const [current, previous, assignments] = await Promise.all([
    aggregateCrewWeek({ userId, start: last.start, end: last.end }),
    aggregateCrewWeek({ userId, start: prevStart, end: prevEnd }),
    db.paketCrew.findMany({
      where: {
        userId,
        paket: {
          status: { not: 'ARCHIVED' },
          deletedAt: null,
          departureDate: { gte: today, lt: upcomingEnd },
        },
      },
      select: {
        paket: {
          select: {
            slug: true, title: true,
            departureDate: true, durationDays: true,
            kursiTotal: true, kursiTerisi: true,
          },
        },
      },
      orderBy: { paket: { departureDate: 'asc' } },
    }),
  ]);

  const deltas = {
    attendanceMarksCount: computeCrewDelta('attendanceMarksCount', current.attendanceMarksCount, previous.attendanceMarksCount),
    presentCount:         computeCrewDelta('presentCount',         current.presentCount,         previous.presentCount),
    absentCount:          computeCrewDelta('absentCount',          current.absentCount,          previous.absentCount),
    paketTouchedCount:    computeCrewDelta('paketTouchedCount',    current.paketTouchedCount,    previous.paketTouchedCount),
  };

  const { attendanceMarksCount, presentCount, absentCount, paketTouchedCount } = current;

  return {
    user,
    label: last.label,
    weekStart: localYmd(last.start),
    weekEnd: localYmd(last.end),
    counts: {
      attendanceMarksCount,
      presentCount,
      absentCount,
      paketTouchedCount,
    },
    previous,
    deltas,
    upcomingPaket: assignments.map((a) => ({
      ...a.paket,
      daysUntilDeparture: Math.floor((a.paket.departureDate.getTime() - today.getTime()) / ONE_DAY_MS),
    })),
  };
}

/**
 * Iterator helper for the cron — every ACTIVE MUTHAWWIF user with an
 * email. Caller loops + builds + fans out per-crew.
 */
export async function listActiveCrewForDigest() {
  return db.user.findMany({
    where: {
      role: 'MUTHAWWIF',
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { id: true, fullName: true, email: true },
  });
}
