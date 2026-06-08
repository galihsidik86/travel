// Stage 126 — admin one-click delivery replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  createWebhook, updateWebhookStatus, replayDelivery, sign,
} from '../src/services/webhooks.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('replayDelivery: not_found on bogus id', async () => {
  const r = await replayDelivery({ deliveryId: 'nonexistent-id-xyz' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('replayDelivery: refuses on SUSPENDED webhook', async (t) => {
  const tag = makeTag('rep-susp');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  await updateWebhookStatus({ req: fakeReq, actor: actor(u), id: w.id, status: 'SUSPENDED' });
  const body = '{}';
  const d = await db.webhookDelivery.create({
    data: {
      webhookId: w.id, eventName: 'booking.created', payload: body, signature: sign(w.secret, body),
      status: 'PENDING', attemptCount: 1,
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { id: d.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const r = await replayDelivery({ deliveryId: d.id });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'webhook_suspended');
});

test('replayDelivery: refuses when attemptCount already at MAX', async (t) => {
  const tag = makeTag('rep-max');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  const body = '{}';
  const d = await db.webhookDelivery.create({
    data: {
      webhookId: w.id, eventName: 'booking.created', payload: body, signature: sign(w.secret, body),
      status: 'FAILED', attemptCount: 5,
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { id: d.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const r = await replayDelivery({ deliveryId: d.id });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'max_attempts_reached');
});

test('replayDelivery: re-fires + bumps attemptCount', async (t) => {
  const tag = makeTag('rep-fire');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  const body = JSON.stringify({ test: 1 });
  const sigVal = sign(w.secret, body);
  const d = await db.webhookDelivery.create({
    data: {
      webhookId: w.id, eventName: 'booking.created', payload: body, signature: sigVal,
      status: 'PENDING', attemptCount: 2,
      lastError: 'previous timeout',
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { id: d.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  // Stub fetch — capture body to confirm SAME signature is used
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => { captured = opts; return { ok: true, status: 200 }; };
  t.after(() => { global.fetch = originalFetch; });

  const r = await replayDelivery({ deliveryId: d.id });
  assert.equal(r.ok, true);

  // Captured POST has the stored signature (proves we re-used, didn't re-sign)
  assert.equal(captured.headers['X-Religio-Signature'], sigVal);
  assert.equal(captured.body, body);

  // Delivery row flipped to SUCCEEDED + attemptCount bumped
  const after = await db.webhookDelivery.findUnique({ where: { id: d.id } });
  assert.equal(after.status, 'SUCCEEDED');
  assert.equal(after.attemptCount, 3, 'was 2, replay bumps to 3');
});
