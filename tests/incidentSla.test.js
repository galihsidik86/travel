import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif } from './_helpers.js';
import { getIncidentSlaReport, percentile, startOfWeekMonday, fmtDurationMs } from '../src/services/incidentSla.js';

const MS_PER_DAY = 86_400_000;

test('percentile: handles edge cases', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([100], 50), 100);
  assert.equal(percentile([100, 200, 300], 50), 200);
  // Linear interpolation between rank 0 and rank 1 at 50% of (n-1)=2 → idx=1.0
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
});

test('startOfWeekMonday: rolls Sunday back to previous Monday', () => {
  // 2026-06-07 is a Sunday
  const sun = new Date(2026, 5, 7, 14, 30, 0);
  const wk = startOfWeekMonday(sun);
  assert.equal(wk.getDay(), 1, 'Monday');
  assert.equal(wk.getDate(), 1);
  assert.equal(wk.getMonth(), 5);
  assert.equal(wk.getHours(), 0);
});

test('fmtDurationMs: human-readable rendering', () => {
  assert.equal(fmtDurationMs(null), '—');
  assert.equal(fmtDurationMs(45_000), '45s');
  assert.equal(fmtDurationMs(180_000), '3m');
  assert.equal(fmtDurationMs(3_900_000), '1j 5m');
  assert.equal(fmtDurationMs(2 * MS_PER_DAY + 3_600_000), '2h 1j');
});

test('getIncidentSlaReport: bucketing + percentiles', async (t) => {
  const tag = makeTag('sla');
  const crew = await tempMuthawwif(t, tag);

  // Create 3 incidents in the SAME week (last week), with varying ack/resolve
  // latencies, so we can assert percentile + counts deterministically.
  // Anchor to last week's Wednesday (regardless of today's day-of-week) to
  // avoid the "5 days ago" pitfall: when today is Sat-Sun, 5d ago lands
  // in the CURRENT week which getIncidentSlaReport excludes.
  const today = new Date();
  const startOfThisWeek = startOfWeekMonday(today);
  const lastWeekMid = new Date(startOfThisWeek.getTime() - 5 * MS_PER_DAY); // Wed of last week
  const inc1 = await db.incident.create({
    data: {
      type: 'SOS', message: 'i1', createdById: crew.id,
      createdAt: lastWeekMid,
      ackedAt: new Date(lastWeekMid.getTime() + 10 * 60_000),    // 10min ack
      resolvedAt: new Date(lastWeekMid.getTime() + 30 * 60_000), // 30min resolve
    },
  });
  const inc2 = await db.incident.create({
    data: {
      type: 'MEDICAL', message: 'i2', createdById: crew.id,
      createdAt: lastWeekMid,
      ackedAt: new Date(lastWeekMid.getTime() + 5 * 60_000),     // 5min ack
      resolvedAt: new Date(lastWeekMid.getTime() + 60 * 60_000), // 60min resolve
    },
  });
  const inc3 = await db.incident.create({
    data: {
      type: 'SOS', message: 'i3', createdById: crew.id,
      createdAt: lastWeekMid,
      escalatedAt: new Date(lastWeekMid.getTime() + 70 * 60_000), // escalated
      // no ack, no resolve — open & aging
    },
  });
  t.after(() => db.incident.deleteMany({ where: { id: { in: [inc1.id, inc2.id, inc3.id] } } }));

  const r = await getIncidentSlaReport({ weeks: 2 });

  // Find the row for last week. Compare via local YMD so TZ differences
  // (server uses local time, ISO uses UTC) don't bite.
  const wantWeek = startOfWeekMonday(lastWeekMid);
  const wantYmd = `${wantWeek.getFullYear()}-${String(wantWeek.getMonth() + 1).padStart(2, '0')}-${String(wantWeek.getDate()).padStart(2, '0')}`;
  const lastWeekRow = r.rows.find((row) => row.weekStart === wantYmd);
  assert.ok(lastWeekRow, 'last-week row present');
  assert.equal(lastWeekRow.created, 3, 'all 3 in same week');
  assert.equal(lastWeekRow.acked, 2, '2 acked');
  assert.equal(lastWeekRow.resolved, 2, '2 resolved');
  assert.equal(lastWeekRow.escalated, 1, '1 escalated');
  assert.equal(lastWeekRow.escalationRatePct, 33.3, '1/3 = 33.3%');
  // Ack latencies were 5min + 10min → p50 ≈ 7.5min in ms
  assert.equal(lastWeekRow.ackP50, Math.round(7.5 * 60_000));
});

test('getIncidentSlaReport: excludes current (incomplete) week', async (t) => {
  const tag = makeTag('sla-curr');
  const crew = await tempMuthawwif(t, tag);
  // Incident today — should be EXCLUDED because current week isn't complete.
  const today = await db.incident.create({
    data: { type: 'OTHER', message: 'now', createdById: crew.id },
  });
  t.after(() => db.incident.deleteMany({ where: { id: today.id } }));

  const r = await getIncidentSlaReport({ weeks: 4 });
  // Find any row that would contain today
  const containsToday = r.rows.some((row) => {
    const start = new Date(row.weekStart).getTime();
    const end = start + 7 * MS_PER_DAY;
    return Date.now() >= start && Date.now() < end;
  });
  assert.equal(containsToday, false, 'current week must NOT appear in report');
});

test('getIncidentSlaReport: no incidents → all rows zero', async () => {
  const r = await getIncidentSlaReport({ weeks: 2, now: new Date('2025-01-01T00:00:00Z') });
  assert.ok(Array.isArray(r.rows));
  for (const row of r.rows) {
    assert.equal(row.created, 0);
    assert.equal(row.escalationRatePct, null, 'null when denominator is 0 (no divide-by-zero)');
    assert.equal(row.ackP50, null);
  }
});

test('getIncidentSlaReport: weeks param clamped 1–52', async () => {
  const r1 = await getIncidentSlaReport({ weeks: 0 });
  assert.ok(r1.rows.length >= 1, 'min 1 week');
  const r2 = await getIncidentSlaReport({ weeks: 100 });
  assert.ok(r2.rows.length <= 52, 'max 52 weeks');
});
