// Stage 53 — traffic anomaly detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { getTrafficAnomalies } from '../src/services/trafficAnomaly.js';
import { notifyTrafficAnomalies } from '../src/services/notifications.js';

const ONE_DAY_MS = 86_400_000;

function localMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

test('paket without traffic does NOT trigger anomaly (below baseline threshold)', async (t) => {
  const tag = makeTag('ta-empty');
  const paket = await tempPaket(t, tag);
  const out = await getTrafficAnomalies();
  assert.ok(!out.rows.some((r) => r.paket.slug === paket.slug),
    'paket with no views must not fire anomaly');
});

test('paket with healthy traffic does NOT trigger', async (t) => {
  const tag = makeTag('ta-healthy');
  const paket = await tempPaket(t, tag);
  const today = localMidnight(new Date());
  const yesterday = new Date(today.getTime() - ONE_DAY_MS);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 10 visits/day for past 8 days
  for (let day = 1; day <= 8; day++) {
    for (let v = 0; v < 10; v++) {
      await db.paketView.create({
        data: {
          paketId: paket.id, visitorId: `${day}-${v}`.padStart(32, '0').slice(-32),
          dayKey: new Date(today.getTime() - day * ONE_DAY_MS).toISOString().slice(0, 10),
          createdAt: new Date(yesterday.getTime() - (day - 1) * ONE_DAY_MS + v * 1000),
        },
      });
    }
  }
  const out = await getTrafficAnomalies();
  assert.ok(!out.rows.some((r) => r.paket.slug === paket.slug),
    'healthy paket with stable traffic must not fire');
});

test('paket with ≥50% drop AND baseline ≥5 fires anomaly', async (t) => {
  const tag = makeTag('ta-drop');
  const paket = await tempPaket(t, tag);
  const today = localMidnight(new Date());
  const yesterday = new Date(today.getTime() - ONE_DAY_MS);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 10 visits/day on each of days 2-8 (baseline avg ≈ 10)
  for (let day = 2; day <= 8; day++) {
    const dayDate = new Date(today.getTime() - day * ONE_DAY_MS);
    for (let v = 0; v < 10; v++) {
      await db.paketView.create({
        data: {
          paketId: paket.id, visitorId: `${day}-${v}`.padStart(32, '0').slice(-32),
          dayKey: dayDate.toISOString().slice(0, 10),
          createdAt: new Date(dayDate.getTime() + v * 1000),
        },
      });
    }
  }
  // Only 2 visits yesterday → 80% drop
  for (let v = 0; v < 2; v++) {
    await db.paketView.create({
      data: {
        paketId: paket.id, visitorId: `y-${v}`.padStart(32, '0').slice(-32),
        dayKey: yesterday.toISOString().slice(0, 10),
        createdAt: new Date(yesterday.getTime() + v * 1000),
      },
    });
  }
  const out = await getTrafficAnomalies();
  const row = out.rows.find((r) => r.paket.slug === paket.slug);
  assert.ok(row, 'paket with ≥50% drop must fire');
  assert.equal(row.yesterday, 2);
  assert.ok(row.dropPct >= 50, `dropPct was ${row.dropPct}`);
});

test('low-baseline paket does NOT fire (avoids false alarms on sleepy paket)', async (t) => {
  const tag = makeTag('ta-sleepy');
  const paket = await tempPaket(t, tag);
  const today = localMidnight(new Date());
  const yesterday = new Date(today.getTime() - ONE_DAY_MS);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // Only 2 visits/day baseline (well below 5 threshold)
  for (let day = 2; day <= 8; day++) {
    const dayDate = new Date(today.getTime() - day * ONE_DAY_MS);
    for (let v = 0; v < 2; v++) {
      await db.paketView.create({
        data: {
          paketId: paket.id, visitorId: `${day}-${v}`.padStart(32, '0').slice(-32),
          dayKey: dayDate.toISOString().slice(0, 10),
          createdAt: new Date(dayDate.getTime() + v * 1000),
        },
      });
    }
  }
  // Zero visits yesterday — 100% drop, but baseline avg is ~1.7/day
  const out = await getTrafficAnomalies();
  assert.ok(!out.rows.some((r) => r.paket.slug === paket.slug),
    'sleepy paket with <5 baseline must not fire');
});

test('notifyTrafficAnomalies silent when no anomalies', async () => {
  const r = await notifyTrafficAnomalies({
    anomalies: { rows: [], counts: { total: 0 }, thresholds: { dropThresholdPct: 50, minBaselineVisits: 5 } },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});
