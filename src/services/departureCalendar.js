// Stage 24 — month-grid view of paket departures.
//
// Pairs with print manifest (per-trip detail) and pre-departure checklist
// (per-trip readiness) — calendar is the trip-by-trip overview that lets
// admin scan a month at a glance: "what's leaving this month? are we
// staffed? are kursi filling fast enough?".
//
// Returned shape (one entry per UTC day in the requested month):
//   {
//     date:           'YYYY-MM-DD'
//     dayNumber:      1-31
//     weekday:        0-6 (Sun=0)
//     isToday:        bool
//     departures:     [{ id, slug, title, kursiTerisi, kursiTotal, status,
//                        fillPct, durationDays, returnDate }]
//     departureCount: number
//   }
// Plus { year, month, prev, next, today } envelope so the view can render
// month-nav buttons without re-computing.

import { db } from '../lib/db.js';

const MONTH_LABELS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

export function clampMonth(year, month) {
  // Inputs may be query strings or numbers; coerce + clamp to a sane range.
  const y = Number.parseInt(year, 10);
  const m = Number.parseInt(month, 10);
  const yOk = Number.isFinite(y) && y >= 2020 && y <= 2100 ? y : null;
  const mOk = Number.isFinite(m) && m >= 1 && m <= 12 ? m : null;
  if (yOk == null || mOk == null) {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }
  return { year: yOk, month: mOk };
}

function fmtDayKey(d) {
  // UTC-aligned YYYY-MM-DD so the bucket keys don't drift on timezone-naive
  // departure dates stored in UTC by Prisma.
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function shiftMonth(year, month, delta) {
  // Returns {year, month} after adding `delta` months. Crosses year boundary.
  const idx0 = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx0 / 12), month: (idx0 % 12 + 12) % 12 + 1 };
}

export async function getDepartureCalendar({ year, month, now = new Date() } = {}) {
  const { year: y, month: m } = clampMonth(year, month);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)); // exclusive (first of next month)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const paket = await db.paket.findMany({
    where: {
      deletedAt: null,
      status: { not: 'ARCHIVED' },
      departureDate: { gte: start, lt: end },
    },
    select: {
      id: true, slug: true, title: true,
      kursiTotal: true, kursiTerisi: true,
      status: true,
      departureDate: true, returnDate: true, durationDays: true,
    },
    orderBy: { departureDate: 'asc' },
  });

  // Bucket by UTC day
  const byDay = new Map();
  for (const p of paket) {
    const key = fmtDayKey(p.departureDate);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({
      id: p.id,
      slug: p.slug,
      title: p.title,
      kursiTerisi: p.kursiTerisi,
      kursiTotal: p.kursiTotal,
      status: p.status,
      fillPct: p.kursiTotal > 0 ? Math.round((p.kursiTerisi / p.kursiTotal) * 100) : 0,
      durationDays: p.durationDays,
      returnDate: p.returnDate,
    });
  }

  // First-of-month UTC weekday (Sun=0) — drives the leading-blank cells
  // in the month grid so dates land in the right Sun-Sat column.
  const firstWeekday = start.getUTCDay();

  const todayKey = fmtDayKey(now);
  const days = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(Date.UTC(y, m - 1, i));
    const key = fmtDayKey(d);
    const departures = byDay.get(key) || [];
    days.push({
      date: key,
      dayNumber: i,
      weekday: d.getUTCDay(),
      isToday: key === todayKey,
      departures,
      departureCount: departures.length,
    });
  }

  return {
    year: y,
    month: m,
    monthLabel: `${MONTH_LABELS_ID[m - 1]} ${y}`,
    firstWeekday,                                       // 0-6 leading offset
    days,
    totalDepartures: paket.length,
    prev: shiftMonth(y, m, -1),
    next: shiftMonth(y, m, +1),
    today: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, date: todayKey },
  };
}
