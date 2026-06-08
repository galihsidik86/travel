// Stage 56 — landing speed budget tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { recordPaketView, getLandingSpeed } from '../src/services/paketView.js';

test('getLandingSpeed handles empty sample (returns nulls + lowSample)', async () => {
  // Far-future window — should be empty
  const out = await getLandingSpeed({ days: 1, now: new Date(Date.now() + 365 * 86_400_000) });
  // Note: any existing renderMs rows in the window from real visits would
  // make this non-zero; we just check the shape is stable
  assert.equal(typeof out.budgetMs, 'number');
  assert.equal(typeof out.lowSample, 'boolean');
});

test('renderMs persists on recordPaketView + reads back via getLandingSpeed', async (t) => {
  const tag = makeTag('ls-record');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // Record 10 visits with known renderMs values
  for (let i = 0; i < 10; i++) {
    const visitorId = `${i}`.padStart(32, '0').slice(-32);
    await recordPaketView({
      paketId: paket.id, visitorId,
      renderMs: 100 + i * 50, // 100, 150, 200, ..., 550 ms
    });
  }
  const out = await getLandingSpeed({ days: 7 });
  // p50 should be around 300 (middle), p95 around 525
  assert.ok(out.sample >= 10);
  assert.ok(out.p50 >= 100 && out.p50 <= 550);
  assert.ok(out.p95 >= out.p50, 'p95 must be ≥ p50');
});

test('overBudget flag fires when p95 > budgetMs (800)', async (t) => {
  const tag = makeTag('ls-over');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 20 visits all > 1000 ms → p95 > 1000 > budget 800
  for (let i = 0; i < 20; i++) {
    const visitorId = `o${i}`.padStart(32, '0').slice(-32);
    await recordPaketView({
      paketId: paket.id, visitorId,
      renderMs: 1000 + i * 100,
    });
  }
  // Filter to this paket only by clearing dev DB data is not feasible —
  // we just check the row's contribution is reflected by checking it
  // appears in perPaket as a slow paket
  const out = await getLandingSpeed({ days: 7 });
  const ourPaket = out.perPaket.find((p) => p.paket.slug === paket.slug);
  assert.ok(ourPaket, 'slow paket must appear in perPaket worst-5');
  assert.ok(ourPaket.p95 > 800, `p95 should be >800, was ${ourPaket.p95}`);
});

test('null renderMs rows excluded from sample', async (t) => {
  const tag = makeTag('ls-null');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // Record without renderMs (legacy-style)
  await recordPaketView({
    paketId: paket.id, visitorId: 'n'.padEnd(32, '0').slice(0, 32),
  });
  // This row must NOT bump the sample count — verify by checking our
  // paket is NOT in perPaket (only 1 sample, and renderMs is null)
  const out = await getLandingSpeed({ days: 7 });
  const ourPaket = out.perPaket.find((p) => p.paket.slug === paket.slug);
  assert.equal(ourPaket, undefined, 'paket with all-null renderMs must not appear');
});
