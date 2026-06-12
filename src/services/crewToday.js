// Stage 246 — crew "Hari ini" dashboard widget. Pulls together three
// signals the crew needs at a glance:
//
//   1. Paket departing within 48 hours (currently-active assignments)
//   2. Attendance days that fall on TODAY for any assigned paket
//      (mark-now CTA)
//   3. Crew's own OPEN/ACKED incidents from the last 7 days
//
// Best-effort: any of the three slices can fail without breaking the
// dashboard. Caller (crew route) renders nulls as empty panels.

import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function getCrewToday({ userId, now = new Date() } = {}) {
  if (!userId) {
    return { departingSoon: [], attendanceDueToday: [], openIncidents: [] };
  }

  const next48h = new Date(now.getTime() + 2 * ONE_DAY_MS);
  // Stage 246 — paket departing within 48h. Includes "today" + tomorrow
  // so crew sees what's about to happen.
  const departingSoon = await db.paketCrew.findMany({
    where: {
      userId,
      paket: {
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        departureDate: { gte: now, lte: next48h },
      },
    },
    select: {
      paketId: true,
      paket: {
        select: {
          id: true, slug: true, title: true, departureDate: true,
          kursiTerisi: true, kursiTotal: true,
        },
      },
    },
    orderBy: { paket: { departureDate: 'asc' } },
  });

  // Stage 246 — attendance days where (departureDate + dayNumber - 1)
  // resolves to TODAY. Computed in JS — schema doesn't store the
  // computed date column. Walks all crew's active paket and their
  // PaketDay rows.
  let attendanceDueToday = [];
  try {
    const todayKey = localYmd(now);
    const assignments = await db.paketCrew.findMany({
      where: {
        userId,
        paket: {
          deletedAt: null,
          status: { not: 'ARCHIVED' },
          // Reasonable window — paket departing within last 30d or
          // next 30d. Past beyond that is closed-book history.
          departureDate: {
            gte: new Date(now.getTime() - 30 * ONE_DAY_MS),
            lte: new Date(now.getTime() + 30 * ONE_DAY_MS),
          },
        },
      },
      select: {
        paket: {
          select: {
            id: true, slug: true, title: true, departureDate: true,
            durationDays: true,
            days: {
              select: { id: true, dayNumber: true, title: true },
              orderBy: { dayNumber: 'asc' },
            },
          },
        },
      },
    });
    for (const a of assignments) {
      const dep = a.paket?.departureDate;
      if (!dep) continue;
      const depStart = new Date(dep);
      depStart.setHours(0, 0, 0, 0);
      for (const day of a.paket.days || []) {
        const dayDate = new Date(depStart.getTime() + (day.dayNumber - 1) * ONE_DAY_MS);
        if (localYmd(dayDate) === todayKey) {
          attendanceDueToday.push({
            paket: { id: a.paket.id, slug: a.paket.slug, title: a.paket.title },
            day: { id: day.id, dayNumber: day.dayNumber, title: day.title },
          });
        }
      }
    }
  } catch (err) {
    console.warn('[crewToday] attendance computation failed:', err?.message || err);
    attendanceDueToday = [];
  }

  // Stage 246 — crew's own incidents (created by them) in OPEN/ACKED
  // state from the last 7 days. RESOLVED ones don't need a CTA.
  const since = new Date(now.getTime() - 7 * ONE_DAY_MS);
  const openIncidents = await db.incident.findMany({
    where: {
      createdById: userId,
      status: { in: ['OPEN', 'ACKED'] },
      createdAt: { gte: since },
    },
    select: {
      id: true, type: true, status: true, message: true,
      createdAt: true, ackedAt: true,
      paket: { select: { slug: true, title: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  return {
    departingSoon: departingSoon.map((a) => a.paket),
    attendanceDueToday,
    openIncidents,
  };
}
