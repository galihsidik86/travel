// Stage 128 — per-paket webhook subscription filter.
// A webhook with `paketId` set should ONLY receive events whose payload
// carries the same paketId. A webhook with paketId=null keeps the legacy
// "all paket" behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempPaket, fakeReq } from './_helpers.js';
import { createWebhook, dispatchEvent } from '../src/services/webhooks.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

function stubFetch(t) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, event: opts?.headers?.['X-Religio-Event'] || null });
    return { status: 200, ok: true };
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test('createWebhook: accepts paketId for per-paket subscription', async (t) => {
  const tag = makeTag('whP-create');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/h',
    events: ['booking.created'],
    paketId: paket.id,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  assert.equal(wh.paketId, paket.id);
});

test('createWebhook: rejects unknown paketId with BAD_PAKET', async (t) => {
  const tag = makeTag('whP-bad-pkt');
  const owner = await tempUser(t, tag, { role: 'OWNER' });

  await assert.rejects(
    () => createWebhook({
      req: fakeReq, actor: actor(owner),
      url: 'https://test.example/h',
      events: ['booking.created'],
      paketId: 'pak-does-not-exist',
    }),
    (err) => err instanceof HttpError && err.code === 'BAD_PAKET',
  );
});

test('dispatchEvent: paket-scoped sub receives matching paketId payload', async (t) => {
  const tag = makeTag('whP-match');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/match',
    events: ['booking.created'],
    paketId: paket.id,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  const r = await dispatchEvent('booking.created', { bookingId: 'abc', paketId: paket.id });

  assert.equal(r.matched, 1);
  assert.equal(r.delivered, 1);
  assert.equal(calls.length, 1);
});

test('dispatchEvent: paket-scoped sub SKIPS event for different paket', async (t) => {
  const tag = makeTag('whP-skip');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const myPaket = await tempPaket(t, `${tag}-mine`);
  const otherPaket = await tempPaket(t, `${tag}-other`);

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/skip',
    events: ['booking.created'],
    paketId: myPaket.id,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  // Event for OTHER paket — must not reach this sub
  const r = await dispatchEvent('booking.created', { bookingId: 'xyz', paketId: otherPaket.id });

  assert.equal(r.matched, 0);
  assert.equal(calls.length, 0);
});

test('dispatchEvent: paket-scoped sub SKIPS event without paketId in payload', async (t) => {
  const tag = makeTag('whP-nopkt');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/nopkt',
    events: ['booking.created'],
    paketId: paket.id,
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  // Payload has no paketId — paket-scoped sub can't tell if it applies
  // to "their" paket, so it must NOT receive the event.
  const r = await dispatchEvent('booking.created', { bookingId: 'untagged' });

  assert.equal(r.matched, 0);
  assert.equal(calls.length, 0);
});

test('dispatchEvent: global sub (paketId=null) receives event regardless of payload paketId', async (t) => {
  const tag = makeTag('whP-global');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/global',
    events: ['booking.created'],
    // No paketId — global sub
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });
  assert.equal(wh.paketId, null);

  const calls = stubFetch(t);
  // Paket-tagged event — global sub should still receive it
  await dispatchEvent('booking.created', { bookingId: 'tagged', paketId: paket.id });
  // Untagged event — global sub also receives it
  await dispatchEvent('booking.created', { bookingId: 'untagged' });
  assert.equal(calls.length, 2);
});

test('dispatchEvent: paket-scoped + global subs coexist for same event', async (t) => {
  const tag = makeTag('whP-mixed');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);

  const scoped = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/scoped',
    events: ['payment.received'],
    paketId: paket.id,
  });
  const global = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/global2',
    events: ['payment.received'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: { in: [scoped.id, global.id] } } });
    await db.webhook.deleteMany({ where: { id: { in: [scoped.id, global.id] } } });
  });

  const calls = stubFetch(t);
  await dispatchEvent('payment.received', { paymentId: 'p1', paketId: paket.id });

  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://test.example/global2', 'https://test.example/scoped']);
});
