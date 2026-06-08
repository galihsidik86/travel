// Stage 60 — getPaketDailyViews helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { getPaketDailyViews, recordPaketView } from '../src/services/paketView.js';

test('returns null for missing paketId', async () => {
  assert.equal(await getPaketDailyViews({ paketId: null }), null);
});

test('zero-fills empty days across the window', async (t) => {
  const tag = makeTag('pdv-empty');
  const paket = await tempPaket(t, tag);
  const out = await getPaketDailyViews({ paketId: paket.id, days: 7 });
  assert.equal(out.days, 7);
  assert.equal(out.points.length, 7);
  assert.equal(out.total, 0);
  // Every point has count: 0
  assert.ok(out.points.every((p) => p.count === 0));
});

test('counts visits in window, oldest→newest', async (t) => {
  const tag = makeTag('pdv-fill');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 3 visits today, 2 visits yesterday, 1 visit 5 days ago
  for (let i = 0; i < 3; i++) {
    await recordPaketView({
      paketId: paket.id, visitorId: `t${i}`.padStart(32, '0').slice(-32),
    });
  }
  // Direct DB inserts for past days so dayKey is right
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ONE_DAY = 86_400_000;
  for (let i = 0; i < 2; i++) {
    const d = new Date(today.getTime() - ONE_DAY);
    await db.paketView.create({
      data: {
        paketId: paket.id,
        visitorId: `y${i}`.padStart(32, '0').slice(-32),
        dayKey: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
        createdAt: d,
      },
    });
  }

  const out = await getPaketDailyViews({ paketId: paket.id, days: 7 });
  assert.ok(out.total >= 5);
  // Last point = today
  const last = out.points[out.points.length - 1];
  assert.ok(last.count >= 3);
  // Second-to-last = yesterday
  const yest = out.points[out.points.length - 2];
  assert.ok(yest.count >= 2);
});
