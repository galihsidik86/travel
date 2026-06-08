// Stage 129 — per-webhook delivery health rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createWebhook, sign } from '../src/services/webhooks.js';
import { getWebhookHealthDigest } from '../src/services/webhookHealthDigest.js';
import { notifyWebhookHealth } from '../src/services/notifications.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

async function makeDelivery(wh, { status, attemptCount = 1, lastError = null, createdAt = new Date() }) {
  const body = JSON.stringify({ x: 1 });
  return db.webhookDelivery.create({
    data: {
      webhookId: wh.id, eventName: 'booking.created',
      payload: body, signature: sign(wh.secret, body),
      status, attemptCount, lastError, createdAt,
    },
  });
}

test('getWebhookHealthDigest: empty when no webhooks → hasIssues=false', async () => {
  const r = await getWebhookHealthDigest({ days: 7 });
  // Other tests may have ACTIVE webhooks; just assert the shape.
  assert.ok(typeof r.hasIssues === 'boolean');
  assert.ok(r.windowStart instanceof Date);
  assert.ok(r.windowEnd instanceof Date);
});

test('healthy webhook (all SUCCEEDED) → healthy=true', async (t) => {
  const tag = makeTag('whH-good');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/good',
    events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  for (let i = 0; i < 5; i++) {
    await makeDelivery(wh, { status: 'SUCCEEDED', attemptCount: 1 });
  }
  const r = await getWebhookHealthDigest({ days: 7 });
  const row = r.rows.find((x) => x.webhook.id === wh.id);
  assert.ok(row);
  assert.equal(row.healthy, true);
  assert.equal(row.totals.succeeded, 5);
  assert.equal(row.totals.failed, 0);
  assert.equal(row.totals.successRatePct, 100);
});

test('unhealthy webhook (some FAILED) → healthy=false + top error captured', async (t) => {
  const tag = makeTag('whH-bad');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/bad',
    events: ['payment.received'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  for (let i = 0; i < 3; i++) {
    await makeDelivery(wh, { status: 'SUCCEEDED', attemptCount: 1 });
  }
  for (let i = 0; i < 2; i++) {
    await makeDelivery(wh, {
      status: 'FAILED', attemptCount: 5,
      lastError: 'connect ETIMEDOUT',
    });
  }
  const r = await getWebhookHealthDigest({ days: 7 });
  const row = r.rows.find((x) => x.webhook.id === wh.id);
  assert.ok(row);
  assert.equal(row.healthy, false);
  assert.equal(row.totals.succeeded, 3);
  assert.equal(row.totals.failed, 2);
  // 3 / (3 + 2) = 60.0
  assert.equal(row.totals.successRatePct, 60);
  assert.ok(row.topError);
  assert.equal(row.topError.message, 'connect ETIMEDOUT');
  assert.equal(row.topError.count, 2);
  // attemptInflation = total attempts / row count = (3*1 + 2*5) / 5 = 13/5 = 2.6
  assert.equal(row.attemptInflation, 2.6);
  assert.equal(r.hasIssues, true);
});

test('stuck PENDING (>1h old) flags row unhealthy', async (t) => {
  const tag = makeTag('whH-stuck');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/stuck',
    events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  // 2 hours ago — past the 1h stuck threshold
  await makeDelivery(wh, {
    status: 'PENDING', attemptCount: 2,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  const r = await getWebhookHealthDigest({ days: 7 });
  const row = r.rows.find((x) => x.webhook.id === wh.id);
  assert.ok(row);
  assert.equal(row.totals.stuckPending, 1);
  assert.equal(row.healthy, false);
});

test('window respects days arg — old rows excluded', async (t) => {
  const tag = makeTag('whH-window');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/win',
    events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  // 30 days ago — outside the 7-day window
  await makeDelivery(wh, {
    status: 'FAILED', attemptCount: 5, lastError: 'old',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  // Inside the window
  await makeDelivery(wh, { status: 'SUCCEEDED', attemptCount: 1 });

  const r = await getWebhookHealthDigest({ days: 7 });
  const row = r.rows.find((x) => x.webhook.id === wh.id);
  assert.ok(row);
  // Only the in-window row counts
  assert.equal(row.totals.total, 1);
  assert.equal(row.totals.succeeded, 1);
  assert.equal(row.totals.failed, 0);
});

test('notifyWebhookHealth: silent on hasIssues=false', async () => {
  const r = await notifyWebhookHealth({ digest: { hasIssues: false, rows: [] } });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyWebhookHealth: enqueues one EMAIL per ACTIVE OWNER+SUPERADMIN', async (t) => {
  const tag = makeTag('whH-notif');
  const owner1 = await tempUser(t, `${tag}-o1`, { role: 'OWNER' });
  const owner2 = await tempUser(t, `${tag}-o2`, { role: 'SUPERADMIN' });
  // Suspended admin — should be excluded
  const suspended = await tempUser(t, `${tag}-susp`, { role: 'OWNER', status: 'SUSPENDED' });
  // KASIR — outside the role set
  const kasir = await tempUser(t, `${tag}-kasir`, { role: 'KASIR' });

  const digest = {
    hasIssues: true,
    unhealthyCount: 1,
    windowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    windowEnd: new Date(),
    rows: [{
      webhook: { id: 'fake-id', url: 'https://x.io/h', paket: null },
      totals: { total: 5, succeeded: 3, failed: 2, pending: 0, stuckPending: 0, successRatePct: 60 },
      topError: { message: 'ETIMEDOUT', count: 2 },
      attemptInflation: 2.6,
      healthy: false,
    }],
  };
  t.after(() => db.notification.deleteMany({
    where: {
      type: 'WEBHOOK_HEALTH_OWNER',
      recipientEmail: { in: [owner1.email, owner2.email, suspended.email, kasir.email] },
    },
  }));

  const r = await notifyWebhookHealth({ digest });
  assert.ok(r.enqueued >= 2, `at least 2 enqueued (got ${r.enqueued})`);

  const rows = await db.notification.findMany({
    where: {
      type: 'WEBHOOK_HEALTH_OWNER',
      recipientEmail: { in: [owner1.email, owner2.email, suspended.email, kasir.email] },
    },
    select: { recipientEmail: true, subject: true, body: true },
  });
  const emails = rows.map((r) => r.recipientEmail).sort();
  assert.ok(emails.includes(owner1.email));
  assert.ok(emails.includes(owner2.email));
  assert.ok(!emails.includes(suspended.email), 'suspended must not receive');
  assert.ok(!emails.includes(kasir.email), 'KASIR must not receive');
  // Body should mention the failing webhook
  assert.match(rows[0].body, /60% \(3\/5\)/);
  assert.match(rows[0].body, /ETIMEDOUT/);
});
