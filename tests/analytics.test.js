// Analytics service tests.
// resolveRange is the most error-prone part (date arithmetic, swap, defaults);
// covered as pure unit. The DB-aggregating helpers (funnel/source/sparkline)
// are smoke-checked for shape — they shell out to Prisma groupBy which is
// already-tested infra, no need to retest its math.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRange, getAgentFunnel, getLeadSourceBreakdown, getDailyActivity,
} from '../src/services/analytics.js';

describe('resolveRange', () => {
  test('defaults to last 30 days when neither bound provided', () => {
    const r = resolveRange({});
    assert.equal(r.days, 30);
    // To = today end-of-day
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    assert.equal(r.to.toDateString(), todayEnd.toDateString());
    // From = 29 days earlier, start-of-day
    const expectedFrom = new Date(); expectedFrom.setDate(expectedFrom.getDate() - 29);
    expectedFrom.setHours(0, 0, 0, 0);
    assert.equal(r.from.toDateString(), expectedFrom.toDateString());
  });

  test('honors explicit YYYY-MM-DD bounds, normalised to day edges', () => {
    const r = resolveRange({ from: '2026-01-10', to: '2026-01-12' });
    assert.equal(r.days, 3, 'inclusive count');
    assert.equal(r.from.getHours(), 0);
    assert.equal(r.from.getMinutes(), 0);
    assert.equal(r.to.getHours(), 23);
    assert.equal(r.to.getMinutes(), 59);
  });

  test('swaps inverted from/to', () => {
    const r = resolveRange({ from: '2026-03-05', to: '2026-03-01' });
    assert.ok(r.from < r.to, 'auto-swap so from < to');
    assert.equal(r.days, 5);
  });

  test('invalid date strings fall back to default range', () => {
    const r = resolveRange({ from: 'not-a-date', to: 'also-bogus' });
    assert.equal(r.days, 30, 'both invalid → 30-day default');
  });

  test('single missing side defaults that side relative to the other', () => {
    const r = resolveRange({ to: '2026-06-01' });
    assert.equal(r.days, 30);
    assert.equal(r.to.toDateString(), new Date('2026-06-01').toDateString());
  });
});

describe('aggregate helpers — shape smoke', () => {
  // These hit Prisma but don't require fixtures — they query globally and
  // we only assert shape. agentId=null means "global view" (admin overview).
  test('getAgentFunnel returns lead/booking counters + percentages + range', async () => {
    const r = await getAgentFunnel(null);
    assert.ok(r.range, 'range echoed back');
    assert.ok(r.lead);
    for (const s of ['COLD', 'WARM', 'CONVERTED', 'LOST']) {
      assert.equal(typeof r.lead[s], 'number', `lead.${s} is a number`);
    }
    assert.equal(typeof r.leadsTotal, 'number');
    assert.equal(typeof r.bookingsHot, 'number');
    assert.equal(typeof r.bookingsLunas, 'number');
    assert.equal(typeof r.bookingsTotal, 'number');
    // Percentages can be null when denominator is 0, otherwise a number
    for (const k of ['convertedFromLeadPct', 'leadLossPct', 'lunasFromBookingPct']) {
      assert.ok(r[k] === null || typeof r[k] === 'number', `${k} is null|number`);
    }
  });

  test('getLeadSourceBreakdown returns array sorted by total desc', async () => {
    const rows = await getLeadSourceBreakdown(null);
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok('source' in row);
      assert.equal(typeof row.total, 'number');
      assert.equal(typeof row.converted, 'number');
      assert.equal(typeof row.lost, 'number');
      assert.equal(typeof row.active, 'number');
      assert.ok(row.conversionPct === null || typeof row.conversionPct === 'number');
    }
    // Sort invariant
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].total >= rows[i].total, 'descending by total');
    }
  });

  test('getDailyActivity returns one bucket per day in range (zero-fill)', async () => {
    const days = await getDailyActivity(null, { from: '2026-01-01', to: '2026-01-05' });
    assert.ok(Array.isArray(days));
    assert.equal(days.length, 5, 'inclusive 5 days');
    for (const d of days) {
      assert.equal(typeof d.date, 'string');
      assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof d.leadsCreated, 'number');
      assert.equal(typeof d.bookingsCreated, 'number');
      assert.equal(typeof d.revenue, 'number');
    }
    // Buckets ascend day-by-day (the absolute dates are UTC-aligned which
    // can land one day earlier than the requested local-midnight bounds —
    // tested below by relative spacing, not exact dates).
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1].date);
      const cur = new Date(days[i].date);
      assert.equal(cur.getTime() - prev.getTime(), 86_400_000, 'exactly 1 day apart');
    }
  });

  test('getDailyActivity caps very large ranges to ≤ 366 days', async () => {
    const days = await getDailyActivity(null, { from: '2020-01-01', to: '2026-12-31' });
    assert.ok(days.length <= 366, `capped (got ${days.length})`);
  });
});
