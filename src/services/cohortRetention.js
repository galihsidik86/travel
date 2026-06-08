// Stage 54 — jemaah cohort retention. For each calendar month, looks at
// jemaah whose FIRST booking landed that month, then asks: how many of
// them came back within 12 months for a second booking?
//
// Cohort math:
//   - Cohort month = first booking's createdAt (year-month).
//   - "Retained" = at least one MORE non-cancelled booking within
//     365 days after the first booking.
//   - Sorted newest cohort first (so admin sees recent trends; old
//     cohorts that are still "young" show low retention rates because
//     the 12-month window hasn't elapsed yet — surfaced via `mature`
//     flag so view can dim them).
//
// CANCELLED + REFUNDED bookings excluded from the cohort — they don't
// reflect a real customer relationship. PENDING + DP_PAID + LUNAS all
// count as "a real second booking" because the jemaah committed.

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;
const RETENTION_WINDOW_DAYS = 365;

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const MONTH_LABEL_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split('-');
  return `${MONTH_LABEL_ID[Number(m) - 1]} ${y}`;
}

export async function getJemaahCohortRetention({ months = 12, now = new Date() } = {}) {
  // Look back N+1 months — the oldest cohort needs a 12-month look-ahead
  // window to be "mature" (i.e. retention number is final, not pending
  // more time to accumulate).
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1);

  // Pull all non-cancelled bookings since the cutoff, ordered by jemaah +
  // createdAt so we can collapse to first-touch per jemaah.
  const bookings = await db.booking.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      createdAt: { gte: cutoff },
    },
    select: { jemaahId: true, createdAt: true },
    orderBy: [{ jemaahId: 'asc' }, { createdAt: 'asc' }],
  });
  if (bookings.length === 0) return { rows: [], windowDays: RETENTION_WINDOW_DAYS };

  // Group by jemaah → array of createdAt sorted asc
  const byJemaah = new Map();
  for (const b of bookings) {
    if (!byJemaah.has(b.jemaahId)) byJemaah.set(b.jemaahId, []);
    byJemaah.get(b.jemaahId).push(b.createdAt);
  }

  // Cohort key = first-booking month → { total, retained }
  const cohorts = new Map();
  for (const dates of byJemaah.values()) {
    const first = dates[0];
    const key = monthKey(first);
    const row = cohorts.get(key) || { yearMonth: key, total: 0, retained: 0 };
    row.total += 1;
    // Retained if any later booking landed within 365 days of first
    const cutoffDate = new Date(first.getTime() + RETENTION_WINDOW_DAYS * ONE_DAY_MS);
    const repeated = dates.some((d, idx) => idx > 0 && d <= cutoffDate);
    if (repeated) row.retained += 1;
    cohorts.set(key, row);
  }

  // Materialise + sort newest first + compute pct + maturity flag
  const todayMid = new Date(now);
  todayMid.setHours(0, 0, 0, 0);
  const rows = [...cohorts.values()].map((c) => {
    const [y, m] = c.yearMonth.split('-').map(Number);
    // The cohort "matures" once the END of the cohort month is more than
    // 365 days in the past (since a jemaah who joined late in the month
    // has until cohortMonthEnd + 365 to come back).
    const cohortMonthEnd = new Date(y, m, 0, 23, 59, 59); // last day of month
    const matureAt = new Date(cohortMonthEnd.getTime() + RETENTION_WINDOW_DAYS * ONE_DAY_MS);
    return {
      ...c,
      label: monthLabel(c.yearMonth),
      retentionPct: c.total === 0 ? null
        : Math.round((c.retained / c.total) * 1000) / 10,
      mature: matureAt < todayMid,
    };
  }).sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));

  // Overall summary — mature cohorts only (the only honest number)
  const matureRows = rows.filter((r) => r.mature);
  const matureTotal = matureRows.reduce((s, r) => s + r.total, 0);
  const matureRetained = matureRows.reduce((s, r) => s + r.retained, 0);

  return {
    rows,
    windowDays: RETENTION_WINDOW_DAYS,
    summary: {
      matureCohortCount: matureRows.length,
      matureJemaahTotal: matureTotal,
      matureRetainedTotal: matureRetained,
      matureRetentionPct: matureTotal > 0
        ? Math.round((matureRetained / matureTotal) * 1000) / 10
        : null,
    },
  };
}
