import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  dispatchEvent, sign, createWebhook, updateWebhookStatus, deleteWebhook, listWebhooks, EVENT_NAMES,
} from '../src/services/webhooks.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('sign: HMAC-SHA256 matches manual recompute', () => {
  const out = sign('secret123', '{"event":"hi"}');
  const want = 'sha256=' + createHmac('sha256', 'secret123').update('{"event":"hi"}').digest('hex');
  assert.equal(out, want);
});

test('createWebhook: rejects non-http URL', async (t) => {
  const tag = makeTag('wh-bad');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await assert.rejects(
    () => createWebhook({ req: fakeReq, actor: actor(u), url: 'ftp://x', events: ['booking.created'] }),
    (err) => err instanceof HttpError && err.code === 'BAD_URL',
  );
});

test('createWebhook: rejects no events selected', async (t) => {
  const tag = makeTag('wh-noev');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await assert.rejects(
    () => createWebhook({ req: fakeReq, actor: actor(u), url: 'https://x.io/h', events: [] }),
    (err) => err instanceof HttpError && err.code === 'NO_EVENTS',
  );
});

test('createWebhook: filters unknown event names silently', async (t) => {
  const tag = makeTag('wh-filter');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h',
    events: ['booking.created', 'not.a.real.event'],
  });
  t.after(() => db.webhook.deleteMany({ where: { id: wh.id } }));
  assert.deepEqual(wh.events, ['booking.created']);
  assert.ok(wh.secret.length >= 32, 'secret generated');
});

test('updateWebhookStatus: ACTIVE ↔ SUSPENDED', async (t) => {
  const tag = makeTag('wh-status');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(() => db.webhook.deleteMany({ where: { id: wh.id } }));

  const susp = await updateWebhookStatus({ req: fakeReq, actor: actor(u), id: wh.id, status: 'SUSPENDED' });
  assert.equal(susp.status, 'SUSPENDED');
  const act = await updateWebhookStatus({ req: fakeReq, actor: actor(u), id: wh.id, status: 'ACTIVE' });
  assert.equal(act.status, 'ACTIVE');
});

test('dispatchEvent: matched=0 when no subscriptions exist for event', async () => {
  const r = await dispatchEvent('nonexistent.event', { x: 1 });
  assert.equal(r.matched, 0);
  assert.equal(r.delivered, 0);
});

test('dispatchEvent: posts to subscribed URLs + records lastFiredAt', async (t) => {
  const tag = makeTag('wh-fire');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  // Stub global fetch to capture the call + return ok.
  const originalFetch = global.fetch;
  const captured = [];
  global.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return { status: 200, ok: true };
  };
  t.after(() => { global.fetch = originalFetch; });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/webhook',
    events: ['booking.created'],
  });
  t.after(() => db.webhook.deleteMany({ where: { id: wh.id } }));

  const r = await dispatchEvent('booking.created', { bookingId: 'abc' });
  assert.equal(r.matched, 1);
  assert.equal(r.delivered, 1);
  assert.equal(r.failed, 0);

  // Captured fetch call
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://test.example/webhook');
  assert.equal(captured[0].opts.method, 'POST');
  assert.match(captured[0].opts.headers['X-Religio-Signature'], /^sha256=[0-9a-f]+$/);
  assert.equal(captured[0].opts.headers['X-Religio-Event'], 'booking.created');
  // Signature verifies
  const body = captured[0].opts.body;
  assert.equal(captured[0].opts.headers['X-Religio-Signature'], sign(wh.secret, body));

  // Row stamped
  const after = await db.webhook.findUnique({ where: { id: wh.id }, select: { lastFiredAt: true, lastStatus: true, lastEventName: true } });
  assert.ok(after.lastFiredAt instanceof Date);
  assert.equal(after.lastStatus, 200);
  assert.equal(after.lastEventName, 'booking.created');
});

test('dispatchEvent: SUSPENDED subs are skipped', async (t) => {
  const tag = makeTag('wh-susp');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { status: 200, ok: true }; };
  t.after(() => { global.fetch = originalFetch; });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  await updateWebhookStatus({ req: fakeReq, actor: actor(u), id: wh.id, status: 'SUSPENDED' });
  t.after(() => db.webhook.deleteMany({ where: { id: wh.id } }));

  await dispatchEvent('booking.created', { x: 1 });
  assert.equal(calls, 0, 'SUSPENDED sub must NOT be hit');
});

test('dispatchEvent: failure stamps lastError + counts as failed', async (t) => {
  const tag = makeTag('wh-fail');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  t.after(() => { global.fetch = originalFetch; });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['payment.received'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const r = await dispatchEvent('payment.received', { x: 1 });
  // S109: first failure is queued for retry (not yet terminal "failed")
  assert.equal(r.queued, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.delivered, 0);
  const after = await db.webhook.findUnique({ where: { id: wh.id }, select: { lastError: true, lastStatus: true } });
  assert.match(after.lastError, /ECONNREFUSED/);
  assert.equal(after.lastStatus, null);
});

test('dispatchEvent: failure inserts WebhookDelivery with PENDING + nextRetryAt', async (t) => {
  const tag = makeTag('wh-retry');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('refused'); };
  t.after(() => { global.fetch = originalFetch; });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const r = await dispatchEvent('booking.created', { x: 1 });
  assert.equal(r.matched, 1);
  assert.equal(r.queued, 1);

  const deliveries = await db.webhookDelivery.findMany({ where: { webhookId: wh.id } });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'PENDING');
  assert.equal(deliveries[0].attemptCount, 1);
  assert.ok(deliveries[0].nextRetryAt instanceof Date);
  assert.match(deliveries[0].lastError, /refused/);
});

test('dispatchEvent: success → SUCCEEDED + nextRetryAt cleared', async (t) => {
  const tag = makeTag('wh-success');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true });
  t.after(() => { global.fetch = originalFetch; });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  await dispatchEvent('booking.created', { x: 1 });
  const deliveries = await db.webhookDelivery.findMany({ where: { webhookId: wh.id } });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'SUCCEEDED');
  assert.equal(deliveries[0].nextRetryAt, null);
});

test('processPendingDeliveries: re-fires PENDING + flips SUCCEEDED on success', async (t) => {
  const { processPendingDeliveries } = await import('../src/services/webhooks.js');
  const tag = makeTag('wh-proc');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['payment.received'],
  });
  const body = JSON.stringify({ x: 1 });
  const d = await db.webhookDelivery.create({
    data: {
      webhookId: wh.id, eventName: 'payment.received', payload: body, signature: sign(wh.secret, body),
      status: 'PENDING', attemptCount: 1,
      nextRetryAt: new Date(Date.now() - 60_000),
      lastError: 'previously timed out',
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { id: d.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true });
  t.after(() => { global.fetch = originalFetch; });

  const r = await processPendingDeliveries();
  assert.ok(r.succeeded >= 1);

  const after = await db.webhookDelivery.findUnique({ where: { id: d.id } });
  assert.equal(after.status, 'SUCCEEDED');
  assert.equal(after.attemptCount, 2);
});

test('processPendingDeliveries: skips SUSPENDED webhook subs', async (t) => {
  const { processPendingDeliveries } = await import('../src/services/webhooks.js');
  const tag = makeTag('wh-susp-d');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://x.io/h', events: ['booking.created'],
  });
  await updateWebhookStatus({ req: fakeReq, actor: actor(u), id: wh.id, status: 'SUSPENDED' });
  const body = JSON.stringify({});
  const d = await db.webhookDelivery.create({
    data: {
      webhookId: wh.id, eventName: 'booking.created', payload: body, signature: sign(wh.secret, body),
      status: 'PENDING', attemptCount: 1,
      nextRetryAt: new Date(Date.now() - 60_000),
    },
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { id: d.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls += 1; return { status: 200, ok: true }; };
  t.after(() => { global.fetch = originalFetch; });

  const r = await processPendingDeliveries();
  assert.ok(r.skipped >= 1);
  assert.equal(calls, 0, 'must NOT fetch for SUSPENDED sub');
});

test('EVENT_NAMES: stable canonical list', () => {
  // Guard against accidental renames — these strings are public contracts.
  assert.ok(EVENT_NAMES.includes('booking.created'));
  assert.ok(EVENT_NAMES.includes('booking.lunas'));
  assert.ok(EVENT_NAMES.includes('payment.received'));
  assert.ok(EVENT_NAMES.includes('refund.issued'));
});
