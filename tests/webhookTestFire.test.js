// Stage 117 — admin test-fire helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { testFireWebhook, createWebhook, sign } from '../src/services/webhooks.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('testFireWebhook: missing webhook returns error', async () => {
  const r = await testFireWebhook({ webhook: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /missing/);
});

test('testFireWebhook: posts signed payload + returns response shape', async (t) => {
  const tag = makeTag('tf-ok');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/hook', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  // Stub fetch to capture + echo OK
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{"received":true}' };
  };
  t.after(() => { global.fetch = originalFetch; });

  const r = await testFireWebhook({ webhook: w, eventName: 'booking.created' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(typeof r.durationMs === 'number');
  assert.match(r.bodyPreview, /received/);

  // Captured call has the right shape
  assert.equal(captured.url, 'https://test.example/hook');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['X-Religio-Test'], 'true');
  assert.equal(captured.opts.headers['X-Religio-Event'], 'booking.created');
  // Signature verifies
  const sigHeader = captured.opts.headers['X-Religio-Signature'];
  assert.equal(sigHeader, sign(w.secret, captured.opts.body));
});

test('testFireWebhook: does NOT insert a WebhookDelivery row', async (t) => {
  const tag = makeTag('tf-no-delivery');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/hook', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const before = await db.webhookDelivery.count({ where: { webhookId: w.id } });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  t.after(() => { global.fetch = originalFetch; });

  await testFireWebhook({ webhook: w, eventName: 'test.ping' });

  const after = await db.webhookDelivery.count({ where: { webhookId: w.id } });
  assert.equal(after, before, 'test-fire must NOT persist a delivery row');
});

test('testFireWebhook: network failure → ok=false + error captured', async (t) => {
  const tag = makeTag('tf-fail');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/dead', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  t.after(() => { global.fetch = originalFetch; });

  const r = await testFireWebhook({ webhook: w });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(r.status, undefined);
});

test('testFireWebhook: customPayload override wins over sample', async (t) => {
  const tag = makeTag('tf-custom');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const w = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/hook', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: w.id } });
    await db.webhook.delete({ where: { id: w.id } });
  });

  const originalFetch = global.fetch;
  let body = null;
  global.fetch = async (_url, opts) => { body = opts.body; return { ok: true, status: 200, text: async () => '' }; };
  t.after(() => { global.fetch = originalFetch; });

  await testFireWebhook({ webhook: w, eventName: 'test.ping', customPayload: { marker: 'custom-xyz' } });
  const parsed = JSON.parse(body);
  assert.equal(parsed.payload.marker, 'custom-xyz');
});
