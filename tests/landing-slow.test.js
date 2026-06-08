// Stage 58 — landing slow alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser } from './_helpers.js';
import { notifyLandingSlow } from '../src/services/notifications.js';

test('notifyLandingSlow silent when speed snapshot is null', async () => {
  const r = await notifyLandingSlow({ speed: null });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyLandingSlow silent when not over budget', async () => {
  const r = await notifyLandingSlow({
    speed: {
      sample: 100, lowSample: false, overBudget: false,
      p50: 200, p95: 500, p99: 700, budgetMs: 800,
      window: { days: 7 }, perPaket: [],
    },
  });
  assert.equal(r.skipped, true);
});

test('notifyLandingSlow silent when lowSample (avoid noise)', async () => {
  const r = await notifyLandingSlow({
    speed: {
      sample: 12, lowSample: true, overBudget: true,
      p50: 800, p95: 1200, p99: 1400, budgetMs: 800,
      window: { days: 7 }, perPaket: [],
    },
  });
  assert.equal(r.skipped, true);
});

test('notifyLandingSlow fans out when over budget + enough samples', async (t) => {
  const tag = makeTag('ls-fan');
  const owner = await tempUser(t, tag, { role: 'OWNER', status: 'ACTIVE' });

  const r = await notifyLandingSlow({
    speed: {
      sample: 150, lowSample: false, overBudget: true,
      p50: 600, p95: 1100, p99: 1500, budgetMs: 800,
      window: { days: 7 },
      perPaket: [
        { paket: { slug: 'aqsa', title: 'Aqsa' }, sample: 50, p50: 700, p95: 1300 },
      ],
    },
  });
  assert.ok(r.enqueued >= 1);

  const row = await db.notification.findFirst({
    where: { type: 'LANDING_SLOW_OWNER', recipientEmail: owner.email },
    select: { subject: true, body: true },
  });
  assert.ok(row);
  assert.match(row.subject, /lambat/);
  assert.match(row.body, /Aqsa/);

  await db.notification.deleteMany({
    where: { type: 'LANDING_SLOW_OWNER', recipientEmail: owner.email },
  });
});
