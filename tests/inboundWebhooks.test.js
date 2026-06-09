// Stage 111 — inbound webhook receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { db, makeTag } from './_helpers.js';
import { receiveInbound, listInbound, replayInbound } from '../src/services/inboundWebhooks.js';

test('receiveInbound: no verifier configured → signatureValid=null + RECEIVED', async (t) => {
  // Use a source with no verifier AND no handler so status stays RECEIVED.
  // (Fonnte gained a handler in S112, so it would flip to HANDLED.)
  delete process.env.WEBHOOK_IN_GENERIC_SECRET;
  const r = await receiveInbound({
    source: 'noverifier-test-only',
    rawBody: '{"hello":"world"}',
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  assert.equal(r.status, 'RECEIVED');
  assert.equal(r.signatureValid, null, 'unknown source → no rule → null');
});

test('receiveInbound: valid HMAC signature → signatureValid=true', async (t) => {
  process.env.WEBHOOK_IN_GENERIC_SECRET = 'secret-xyz';
  const body = JSON.stringify({ msg: 'hi' });
  const sig = createHmac('sha256', 'secret-xyz').update(body).digest('hex');
  const r = await receiveInbound({
    source: 'generic',
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'x-religio-signature': 'sha256=' + sig,
    },
  });
  t.after(async () => {
    if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } });
    delete process.env.WEBHOOK_IN_GENERIC_SECRET;
  });

  assert.equal(r.signatureValid, true);
  // generic has no handler → status stays RECEIVED
  assert.equal(r.status, 'RECEIVED');
});

test('receiveInbound: bad signature → REJECTED + stored anyway', async (t) => {
  process.env.WEBHOOK_IN_FONNTE_SECRET = 'secret-xyz';
  const r = await receiveInbound({
    source: 'fonnte',
    rawBody: '{"x":1}',
    headers: {
      'content-type': 'application/json',
      'x-fonnte-signature': 'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
    },
  });
  t.after(async () => {
    if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } });
    delete process.env.WEBHOOK_IN_FONNTE_SECRET;
  });

  assert.equal(r.signatureValid, false);
  assert.equal(r.status, 'REJECTED');
  // Still persisted (audit trail of attempted forgery)
  assert.ok(r.id);
});

test('receiveInbound: only x-/content-type/user-agent headers kept', async (t) => {
  const r = await receiveInbound({
    source: 'generic',
    rawBody: '{}',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Test/1.0',
      'cookie': 'session=secret',
      'authorization': 'Bearer eyJ...',
      'x-custom-header': 'kept',
    },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  const row = await db.inboundWebhook.findUnique({ where: { id: r.id } });
  const kept = row.headers || {};
  assert.ok('content-type' in kept);
  assert.ok('user-agent' in kept);
  assert.ok('x-custom-header' in kept);
  assert.ok(!('cookie' in kept), 'cookie must be stripped');
  assert.ok(!('authorization' in kept), 'authorization must be stripped');
});

test('replayInbound: source with no handler → row stays RECEIVED → refused as no_action_needed (S130)', async (t) => {
  // S130 — the status gate runs before the handler check. A passive
  // `generic` source POST lands as RECEIVED, and S130 treats RECEIVED
  // as "nothing to retry" regardless of whether a handler is later
  // registered. (The `no_handler_for_source` reason is now only
  // reachable when status=HANDLER_ERROR and the handler was REMOVED
  // since the failure — a degenerate path, but still covered.)
  const r = await receiveInbound({
    source: 'generic',
    rawBody: '{}',
    headers: { 'content-type': 'application/json' },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  const rep = await replayInbound(r.id);
  assert.equal(rep.ok, false);
  assert.equal(rep.reason, 'no_action_needed');
});

test('replayInbound: returns not_found for bogus id', async () => {
  const r = await replayInbound('nope-id-xyz');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('listInbound: filters by source', async (t) => {
  const tag = makeTag('inb-list');
  const r1 = await receiveInbound({ source: 'fonnte', rawBody: '{}', headers: {} });
  const r2 = await receiveInbound({ source: 'zapier', rawBody: '{}', headers: {} });
  t.after(async () => {
    if (r1.id) await db.inboundWebhook.delete({ where: { id: r1.id } });
    if (r2.id) await db.inboundWebhook.delete({ where: { id: r2.id } });
  });

  const fonnteOnly = await listInbound({ source: 'fonnte' });
  const ids = fonnteOnly.map((x) => x.id);
  assert.ok(ids.includes(r1.id));
  assert.ok(!ids.includes(r2.id));
});
