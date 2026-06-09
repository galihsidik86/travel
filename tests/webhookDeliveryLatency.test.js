// Stage 134 — WebhookDelivery.durationMs + p95 latency in health digest.
// Closes the explicit deferral note from S129.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createWebhook, dispatchEvent, sign } from '../src/services/webhooks.js';
import {
  getWebhookHealthDigest, computeLatencyStats,
  LATENCY_BUDGET_MS, LATENCY_MIN_SAMPLE,
} from '../src/services/webhookHealthDigest.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

test('computeLatencyStats: below LATENCY_MIN_SAMPLE → nulls (no noisy percentile)', () => {
  const r = computeLatencyStats([100, 200]);
  assert.equal(r.sample, 2);
  assert.equal(r.p50, null);
  assert.equal(r.p95, null);
  assert.equal(r.overBudget, false);
});

test('computeLatencyStats: ≥3 samples → p50 + p95 computed', () => {
  // 10 samples: 100..1000ms
  const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const r = computeLatencyStats(samples);
  assert.equal(r.sample, 10);
  assert.equal(r.p50, 600);  // floor(0.5*10) = 5 → samples[5] = 600
  assert.equal(r.p95, 1000); // floor(0.95*10) = 9 → samples[9] = 1000
  assert.equal(r.overBudget, false); // 1000 < 2000ms budget
});

test('computeLatencyStats: p95 > budget → overBudget=true', () => {
  const samples = [100, 200, 300, 4000, 5000];
  const r = computeLatencyStats(samples);
  assert.equal(r.overBudget, true);
});

test('attemptDelivery: stamps durationMs on success', async (t) => {
  const tag = makeTag('whL-success');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/dur', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true });
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { bookingId: 'd1' });
  const rows = await db.webhookDelivery.findMany({ where: { webhookId: wh.id } });
  assert.equal(rows.length, 1);
  assert.ok(Number.isFinite(rows[0].durationMs), 'durationMs stamped');
  assert.ok(rows[0].durationMs >= 0);
});

test('attemptDelivery: stamps durationMs on failure too', async (t) => {
  const tag = makeTag('whL-fail');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/durFail', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('connect refused'); };
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { bookingId: 'd2' });
  const rows = await db.webhookDelivery.findMany({ where: { webhookId: wh.id } });
  assert.equal(rows.length, 1);
  assert.ok(Number.isFinite(rows[0].durationMs), 'durationMs stamped even on failure');
});

test('getWebhookHealthDigest: surfaces p50/p95 + flags overBudget rows unhealthy', async (t) => {
  const tag = makeTag('whL-digest');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/slowboth', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  // Seed 5 successful deliveries with high latency to push p95 over budget
  const body = JSON.stringify({ x: 1 });
  for (const ms of [500, 1500, 2500, 3500, 4500]) {
    await db.webhookDelivery.create({
      data: {
        webhookId: wh.id, eventName: 'booking.created',
        payload: body, signature: sign(wh.secret, body),
        status: 'SUCCEEDED', attemptCount: 1,
        durationMs: ms,
      },
    });
  }

  const digest = await getWebhookHealthDigest({ days: 7 });
  const row = digest.rows.find((r) => r.webhook.id === wh.id);
  assert.ok(row);
  assert.equal(row.latency.sample, 5);
  assert.equal(row.latency.p50, 2500);
  assert.equal(row.latency.p95, 4500);
  assert.equal(row.latency.overBudget, true, '4500ms > 2000ms budget');
  // Slow-but-working is still unhealthy — admin should see it
  assert.equal(row.healthy, false);
  assert.equal(digest.hasIssues, true);
});

test('getWebhookHealthDigest: under budget + no failures → healthy', async (t) => {
  const tag = makeTag('whL-fast');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/fast', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const body = JSON.stringify({ x: 1 });
  for (const ms of [100, 120, 150, 200, 250]) {
    await db.webhookDelivery.create({
      data: {
        webhookId: wh.id, eventName: 'booking.created',
        payload: body, signature: sign(wh.secret, body),
        status: 'SUCCEEDED', attemptCount: 1,
        durationMs: ms,
      },
    });
  }

  const digest = await getWebhookHealthDigest({ days: 7 });
  const row = digest.rows.find((r) => r.webhook.id === wh.id);
  assert.ok(row);
  assert.equal(row.latency.overBudget, false);
  assert.equal(row.healthy, true);
});
