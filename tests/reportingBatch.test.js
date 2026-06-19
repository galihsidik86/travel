// Stage 385-387 — Reporting deeper batch:
//   S385 LTV by acquisition channel
//   S386 Break-even season comparison
//   S387 Agent efficiency (revenue per lead-hour)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { db } from './_helpers.js';

// ── S385 — LTV by channel ────────────────────────────────────

test('S385 — getLtvByChannel returns rows grouped by channel', async () => {
  const { getLtvByChannel, channelFor, channelLabel } = await import('../src/services/ltvByChannel.js');
  // Test helpers directly
  assert.equal(channelFor({ utmSource: 'fb', agentSlugCap: null }), 'utm:fb');
  assert.equal(channelFor({ utmSource: null, agentSlugCap: 'ahmad-w' }), 'agen:ahmad-w');
  assert.equal(channelFor({ utmSource: null, agentSlugCap: null }), 'direct');
  assert.equal(channelLabel('utm:fb'), 'UTM: fb');
  assert.equal(channelLabel('agen:ahmad-w'), 'Agen: ahmad-w');
  assert.equal(channelLabel('direct'), 'Direct / Walk-in');

  // Run service against seed
  const r = await getLtvByChannel({ months: 12 });
  assert.ok(Array.isArray(r.rows));
  assert.ok(r.totals);
  // Rows sorted by totalLunasRevenueIdr desc
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(r.rows[i - 1].totalLunasRevenueIdr >= r.rows[i].totalLunasRevenueIdr);
  }
  // Each row has all expected fields
  for (const row of r.rows) {
    assert.ok('channel' in row);
    assert.ok('jemaahCount' in row);
    assert.ok('totalLunasRevenueIdr' in row);
    assert.ok('avgRevenuePerJemaahIdr' in row);
    assert.equal('lowSample' in row, true);
  }
});

test('S385 — conversion + repeat rates suppressed for low-sample channels', async () => {
  const { getLtvByChannel, MIN_SAMPLE } = await import('../src/services/ltvByChannel.js');
  assert.equal(MIN_SAMPLE, 5);
  const r = await getLtvByChannel({ months: 12 });
  // Low-sample rows have conversionRatePct=null
  for (const row of r.rows) {
    if (row.jemaahCount < MIN_SAMPLE) {
      assert.equal(row.conversionRatePct, null, `low-sample channel ${row.channel} has null conversion`);
      assert.equal(row.lowSample, true);
    }
  }
});

// ── S386 — Break-even season comparison ───────────────────────

test('S386 — getBreakEvenSeasonComparison returns rows + minLunas guard', async () => {
  const { getBreakEvenSeasonComparison } = await import('../src/services/breakEvenSeason.js');
  const r = await getBreakEvenSeasonComparison({ limit: 10 });
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.minLunas, 3);
  // Each row has paket + current + previous (or null)
  for (const row of r.rows) {
    assert.ok(row.paket);
    assert.ok(row.current);
    // previous can be null if clonedFromId points to a deleted paket
    assert.ok(row.previous === null || row.previous.paket);
    // delta + pctFaster are null OR numeric
    assert.ok(row.deltaDays === null || typeof row.deltaDays === 'number');
    assert.ok(row.pctFaster === null || typeof row.pctFaster === 'number');
  }
});

// ── S387 — Agent efficiency ──────────────────────────────────

test('S387 — getAgentEfficiency returns per-agent rows', async () => {
  const { getAgentEfficiency, MIN_CONVERTED } = await import('../src/services/agentEfficiency.js');
  assert.equal(MIN_CONVERTED, 3);
  const r = await getAgentEfficiency({ months: 6 });
  assert.ok(Array.isArray(r.rows));
  // Rows sorted by revenuePerLeadHourIdr desc (low-sample to back)
  let foundLowSample = false;
  for (const row of r.rows) {
    if (row.lowSample) foundLowSample = true;
    if (foundLowSample) {
      // Once we hit lowSample, all subsequent must also be low-sample
      // (sort order: lowSample to the back)
      assert.ok(row.lowSample, 'lowSample rows clustered at the end');
    }
    assert.ok('slug' in row);
    assert.ok('totalLeads' in row);
    assert.ok('lunasLeads' in row);
    assert.ok('revenuePerLeadHourIdr' in row || row.lunasLeads === 0);
  }
});

// ── View integration ─────────────────────────────────────────

test('S385-S387 — admin-dashboard view renders all 3 panels', async () => {
  const src = await fs.readFile('./views/admin-dashboard.ejs', 'utf8');
  assert.match(src, /ltvByChannel/);
  assert.match(src, /LTV per channel akuisisi/);
  assert.match(src, /breakEvenSeason/);
  assert.match(src, /Break-even per season/);
  assert.match(src, /agentEfficiency/);
  assert.match(src, /Efisiensi agen/);
  // Each panel hidden when source is null/empty
  assert.match(src, /ltvByChannel\.rows\.length > 0/);
  assert.match(src, /breakEvenSeason\.rows\.length > 0/);
  assert.match(src, /agentEfficiency\.rows\.length > 0/);
});

test('S385-S387 — adminDashboard service wires all 3 sources', async () => {
  const src = await fs.readFile('./src/services/adminDashboard.js', 'utf8');
  assert.match(src, /ltvByChannel/);
  assert.match(src, /breakEvenSeason/);
  assert.match(src, /agentEfficiency/);
  // Each in try/catch — failure dims panel without 500'ing overview
  assert.match(src, /\[admin-overview\] ltvByChannel/);
  assert.match(src, /\[admin-overview\] breakEvenSeason/);
  assert.match(src, /\[admin-overview\] agentEfficiency/);
});
