// Stage 112 — Fonnte delivery receipt handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { receiveInbound } from '../src/services/inboundWebhooks.js';

async function makeWaSent(tag, phone) {
  return db.notification.create({
    data: {
      type: 'BOOKING_CREATED',
      channel: 'WA',
      status: 'SENT',
      recipientPhone: phone,
      body: 'test body ' + tag,
      sentAt: new Date(),
      attemptCount: 1,
    },
  });
}

test('fonnte handler: status=failed → notif flipped to FAILED + reason stored', async (t) => {
  const tag = makeTag('fd-fail');
  delete process.env.WEBHOOK_IN_FONNTE_SECRET;   // accept-anything mode
  const phone = '0812' + Date.now().toString().slice(-7);
  const n = await makeWaSent(tag, phone);
  t.after(async () => {
    await db.notification.deleteMany({ where: { id: n.id } });
  });

  const r = await receiveInbound({
    source: 'fonnte',
    rawBody: JSON.stringify({ target: phone.replace(/^0/, '62'), status: 'failed', reason: 'number not registered' }),
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  assert.equal(r.status, 'HANDLED');

  const after = await db.notification.findUnique({ where: { id: n.id } });
  assert.equal(after.status, 'FAILED');
  assert.match(after.error, /number not registered/);
  assert.equal(after.nextRetryAt, null);
});

test('fonnte handler: status=delivered → leaves SENT + annotates payload', async (t) => {
  const tag = makeTag('fd-deliv');
  const phone = '0813' + Date.now().toString().slice(-7);
  const n = await makeWaSent(tag, phone);
  t.after(async () => {
    await db.notification.deleteMany({ where: { id: n.id } });
  });

  const r = await receiveInbound({
    source: 'fonnte',
    rawBody: JSON.stringify({ target: phone, status: 'delivered' }),
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  assert.equal(r.status, 'HANDLED');

  const after = await db.notification.findUnique({ where: { id: n.id } });
  assert.equal(after.status, 'SENT', 'success receipt should NOT flip status');
  const fd = after.payload?.fonnteDelivery;
  assert.ok(fd, 'fonnteDelivery annotated');
  assert.equal(fd.status, 'delivered');
});

test('fonnte handler: no matching notif → silent (HANDLED, no error)', async (t) => {
  const r = await receiveInbound({
    source: 'fonnte',
    rawBody: JSON.stringify({ target: '628999999999', status: 'failed', reason: 'x' }),
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });
  assert.equal(r.status, 'HANDLED');
});

test('fonnte handler: phone normalisation matches across formats', async (t) => {
  const tag = makeTag('fd-norm');
  // Stored with leading 0; Fonnte sends 62-prefixed
  const stored = '0822-1234-9999';
  const n = await makeWaSent(tag, stored);
  t.after(async () => {
    await db.notification.deleteMany({ where: { id: n.id } });
  });

  const r = await receiveInbound({
    source: 'fonnte',
    rawBody: JSON.stringify({ target: '+62 822-1234-9999', status: 'failed', reason: 'block' }),
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  const after = await db.notification.findUnique({ where: { id: n.id } });
  assert.equal(after.status, 'FAILED', 'normalised phone match across formats');
});
