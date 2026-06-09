// Stage 131 — per-subscription burst rate-limit.
// When a sub exceeds its `rateLimitPerMin` bucket, dispatchEvent must
// NOT fire the HTTP call — instead queue the delivery row as PENDING
// with nextRetryAt = end-of-window. Prevents seed scripts / backfills
// from hammering a partner endpoint into IP-ban.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createWebhook, dispatchEvent, updateWebhookRateLimit } from '../src/services/webhooks.js';
import { setRateLimitStore } from '../src/middleware/rateLimit.js';
import { makeMemoryStore } from '../src/lib/rateLimitStore.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

function stubFetch(t) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url });
    return { status: 200, ok: true };
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test('createWebhook: stores rateLimitPerMin (default 30 when omitted)', async (t) => {
  const tag = makeTag('whR-default');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/r', events: ['booking.created'],
    // no rateLimitPerMin
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  assert.equal(wh.rateLimitPerMin, 30);
});

test('createWebhook: clamps rateLimitPerMin to 1..600', async (t) => {
  const tag = makeTag('whR-clamp');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const low = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/low', events: ['booking.created'],
    rateLimitPerMin: -50,
  });
  const high = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/high', events: ['booking.created'],
    rateLimitPerMin: 99_999,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: { in: [low.id, high.id] } } });
    await db.webhook.deleteMany({ where: { id: { in: [low.id, high.id] } } });
  });
  assert.equal(low.rateLimitPerMin, 1, 'negative → clamp to floor 1');
  assert.equal(high.rateLimitPerMin, 600, '>600 → clamp to ceiling 600');
});

test('updateWebhookRateLimit: changes value + writes audit', async (t) => {
  const tag = makeTag('whR-update');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/u', events: ['booking.created'],
    rateLimitPerMin: 30,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Webhook', entityId: wh.id } });
  });

  const after = await updateWebhookRateLimit({
    req: fakeReq, actor: actor(u), id: wh.id, rateLimitPerMin: 120,
  });
  assert.equal(after.rateLimitPerMin, 120);

  // No-op when value unchanged
  const same = await updateWebhookRateLimit({
    req: fakeReq, actor: actor(u), id: wh.id, rateLimitPerMin: 120,
  });
  assert.equal(same.rateLimitPerMin, 120);

  const audits = await db.auditLog.findMany({
    where: { entity: 'Webhook', entityId: wh.id, action: 'UPDATE' },
  });
  assert.equal(audits.length, 1, 'one audit row — no-op update skip-audit');
});

test('dispatchEvent: over-rate-limit → delivery queued PENDING, no fetch fired', async (t) => {
  const tag = makeTag('whR-burst');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  // Tight limit so we can blow past it quickly
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/burst', events: ['booking.created'],
    rateLimitPerMin: 2,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  // Install a memory store for the rate-limit check
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const calls = stubFetch(t);

  // 5 rapid dispatches; only first 2 should fire HTTP, last 3 queue
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await dispatchEvent('booking.created', { bookingId: `b${i}` }));
  }

  assert.equal(calls.length, 2, 'only 2 events fire HTTP — rest are queued');
  const totalRateLimited = results.reduce((s, r) => s + (r.rateLimited || 0), 0);
  assert.equal(totalRateLimited, 3);

  const queued = await db.webhookDelivery.findMany({
    where: { webhookId: wh.id, status: 'PENDING' },
  });
  // 3 queued by rate-limit
  assert.ok(queued.length >= 3, `got ${queued.length} queued, expected ≥3`);
  // Queued rows have nextRetryAt set + a clear lastError
  for (const q of queued) {
    assert.ok(q.nextRetryAt instanceof Date);
    assert.match(q.lastError, /rate_limited/);
  }
});

test('dispatchEvent: fail-open when rate-limit store throws (Redis blip etc.)', async (t) => {
  const tag = makeTag('whR-failopen');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  // Tight limit so fail-open would otherwise immediately trip
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/fo', events: ['booking.created'],
    rateLimitPerMin: 1,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  // Install a broken store — every .hit() throws. Rate-limit check
  // catches the error and treats it as "under limit" (webhooks are
  // higher-priority than rate-limit perfection; flaky Redis shouldn't
  // drop legitimate traffic).
  setRateLimitStore({
    kind: 'broken',
    hit: async () => { throw new Error('redis down'); },
    stop: async () => {},
  });
  t.after(() => setRateLimitStore(null));

  const calls = stubFetch(t);
  for (let i = 0; i < 3; i++) {
    await dispatchEvent('booking.created', { bookingId: `b${i}` });
  }
  assert.equal(calls.length, 3, 'broken store → fail-open → all 3 fire');
});
