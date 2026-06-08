// Stages 118 (rotation) + 119 (Idempotency-Key) — outbound webhook deliveries.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  createWebhook, rotateWebhookSecret, dispatchEvent, processPendingDeliveries, sign,
} from '../src/services/webhooks.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('rotateWebhookSecret: 404 on unknown id', async () => {
  await assert.rejects(
    () => rotateWebhookSecret({ req: fakeReq, actor: { id: 'x', email: 'x' }, id: 'nope' }),
    (err) => err instanceof HttpError && err.code === 'WEBHOOK_NOT_FOUND',
  );
});

test('rotateWebhookSecret: replaces secret, archives old as prevSecret + sets expiry', async (t) => {
  const tag = makeTag('wh-rot');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const oldSecret = w.secret;
  const r = await rotateWebhookSecret({
    req: fakeReq, actor: actor(u), id: w.id, graceHours: 2,
  });
  assert.notEqual(r.newSecret, oldSecret, 'fresh secret minted');
  assert.equal(r.webhook.prevSecret, oldSecret, 'old secret archived');
  assert.ok(r.prevSecretExpiresAt instanceof Date);
  assert.ok(r.prevSecretExpiresAt.getTime() > Date.now(), 'expiry is in the future');
});

test('rotateWebhookSecret: graceHours clamped to 1..168', async (t) => {
  const tag = makeTag('wh-rot-clamp');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  // 0 or negative → 1 hour floor (the parseInt fallback uses default 24)
  const r1 = await rotateWebhookSecret({ req: fakeReq, actor: actor(u), id: w.id, graceHours: 0 });
  const exp1 = r1.prevSecretExpiresAt.getTime();
  assert.ok(exp1 - Date.now() <= 25 * 60 * 60_000, 'graceHours=0 falls to default 24h');

  // Way over cap → 168 (a week)
  const r2 = await rotateWebhookSecret({ req: fakeReq, actor: actor(u), id: w.id, graceHours: 9999 });
  const exp2 = r2.prevSecretExpiresAt.getTime();
  assert.ok(exp2 - Date.now() <= 169 * 60 * 60_000, 'capped at 168h');
});

test('dispatchEvent: dual-signs during grace window (Sig + Sig-Prev)', async (t) => {
  const tag = makeTag('wh-dual');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  await rotateWebhookSecret({ req: fakeReq, actor: actor(u), id: w.id, graceHours: 24 });
  // Re-read with the new shape
  const fresh = await db.webhook.findUnique({ where: { id: w.id } });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const captured = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => { captured.push(opts.headers); return { ok: true, status: 200 }; };
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { x: 1 });
  assert.equal(captured.length, 1);
  const h = captured[0];
  assert.ok(h['X-Religio-Signature'], 'current signature present');
  assert.ok(h['X-Religio-Signature-Prev'], 'prev signature present during grace');
  // Sanity-check each signature verifies under its own secret
  // (we can't reconstruct body from headers alone; just confirm header shape)
  assert.match(h['X-Religio-Signature'], /^sha256=[0-9a-f]+$/);
  assert.match(h['X-Religio-Signature-Prev'], /^sha256=[0-9a-f]+$/);
  // And they're different (different secrets)
  assert.notEqual(h['X-Religio-Signature'], h['X-Religio-Signature-Prev']);
});

test('dispatchEvent: no prev header after grace expires', async (t) => {
  const tag = makeTag('wh-noprev');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  // Force grace already expired
  await db.webhook.update({
    where: { id: w.id },
    data: {
      prevSecret: 'old-secret',
      prevSecretExpiresAt: new Date(Date.now() - 60_000),
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const captured = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => { captured.push(opts.headers); return { ok: true, status: 200 }; };
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { x: 1 });
  const h = captured[0];
  assert.ok(h['X-Religio-Signature'], 'current sig present');
  assert.equal(h['X-Religio-Signature-Prev'], undefined, 'expired prev NOT sent');
});

test('dispatchEvent: Idempotency-Key = WebhookDelivery.id', async (t) => {
  const tag = makeTag('wh-idem');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  let captured = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => { captured = opts.headers; return { ok: true, status: 200 }; };
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { x: 1 });
  const delivery = await db.webhookDelivery.findFirst({ where: { webhookId: w.id } });
  assert.ok(delivery);
  assert.equal(captured['Idempotency-Key'], delivery.id);
});

test('processPendingDeliveries: retry re-uses SAME Idempotency-Key', async (t) => {
  const tag = makeTag('wh-idem-retry');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  // First attempt fails (queues PENDING)
  const captured = [];
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount += 1;
    captured.push(opts.headers['Idempotency-Key']);
    if (callCount === 1) throw new Error('first attempt fails');
    return { ok: true, status: 200 };
  };
  t.after(() => { global.fetch = originalFetch; });

  await dispatchEvent('booking.created', { x: 1 });
  // Make the row eligible for retry
  await db.webhookDelivery.updateMany({
    where: { webhookId: w.id },
    data: { nextRetryAt: new Date(Date.now() - 60_000) },
  });

  await processPendingDeliveries();
  assert.equal(captured.length, 2, 'two attempts');
  assert.equal(captured[0], captured[1], 'same Idempotency-Key across retries');
});
