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
  // 30-day upcoming window from today midnight
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const upcomingEnd = new Date(today.getTime() + 30 * ONE_DAY_MS);

  const [marks, assignments] = await Promise.all([
    db.attendanceMark.findMany({
      where: {
        markedByUserId: userId,
        markedAt: { gte: last.start, lt: last.end },
      },
      select: {
        present: true,
        paketDay: { select: { paketId: true } },
      },
    }),
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

  const presentCount = marks.filter((m) => m.present).length;
  const absentCount = marks.length - presentCount;
  const paketTouchedCount = new Set(marks.map((m) => m.paketDay?.paketId).filter(Boolean)).size;

  return {
    user,
    label: last.label,
    weekStart: localYmd(last.start),
    weekEnd: localYmd(last.end),
    counts: {
      attendanceMarksCount: marks.length,
      presentCount,
      absentCount,
      paketTouchedCount,
    },
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
