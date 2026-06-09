// Stage 130 — replay gate refuses on RECEIVED / REJECTED / HANDLED
// so the admin button doesn't double-fire side effects or pretend to
// re-verify a bad-signature row.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from './_helpers.js';
import { canReplayInbound, replayInbound, HANDLERS } from '../src/services/inboundWebhooks.js';

test('canReplayInbound: HANDLED → refuse already_succeeded', () => {
  // fonnte has a handler registered, so the source check would pass —
  // status is the gate.
  const r = canReplayInbound({ status: 'HANDLED', source: 'fonnte' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_succeeded');
});

test('canReplayInbound: REJECTED → refuse bad_signature', () => {
  const r = canReplayInbound({ status: 'REJECTED', source: 'fonnte' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('canReplayInbound: RECEIVED → refuse no_action_needed', () => {
  const r = canReplayInbound({ status: 'RECEIVED', source: 'fonnte' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_action_needed');
});

test('canReplayInbound: HANDLER_ERROR + registered handler → allow', () => {
  assert.ok(HANDLERS.fonnte, 'sanity: fonnte handler registered');
  const r = canReplayInbound({ status: 'HANDLER_ERROR', source: 'fonnte' });
  assert.equal(r.ok, true);
});

test('canReplayInbound: HANDLER_ERROR + unknown source → refuse no_handler_for_source', () => {
  const r = canReplayInbound({ status: 'HANDLER_ERROR', source: 'made-up-source' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_handler_for_source');
});

test('replayInbound: HANDLED row refused without re-running handler', async (t) => {
  // Stub the fonnte handler so we can detect if it ran. If our gate
  // works, the stub is never called.
  const originalHandler = HANDLERS.fonnte;
  let handlerCalls = 0;
  HANDLERS.fonnte = async () => { handlerCalls += 1; };
  t.after(() => { HANDLERS.fonnte = originalHandler; });

  const row = await db.inboundWebhook.create({
    data: {
      source: 'fonnte',
      headers: {},
      payload: '{"target":"+62811","status":"delivered"}',
      signatureValid: null,
      status: 'HANDLED',
    },
  });
  t.after(() => db.inboundWebhook.delete({ where: { id: row.id } }));

  const r = await replayInbound(row.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_succeeded');
  assert.equal(handlerCalls, 0, 'handler must NOT run on HANDLED replay');
});

test('replayInbound: HANDLER_ERROR row re-fires handler + flips to HANDLED on success', async (t) => {
  const originalHandler = HANDLERS.fonnte;
  let handlerCalls = 0;
  HANDLERS.fonnte = async () => { handlerCalls += 1; };
  t.after(() => { HANDLERS.fonnte = originalHandler; });

  const row = await db.inboundWebhook.create({
    data: {
      source: 'fonnte',
      headers: {},
      payload: '{"target":"+62811","status":"delivered"}',
      signatureValid: null,
      status: 'HANDLER_ERROR',
      handlerError: 'previously: TypeError x is undefined',
    },
  });
  t.after(() => db.inboundWebhook.delete({ where: { id: row.id } }));

  const r = await replayInbound(row.id);
  assert.equal(r.ok, true);
  assert.equal(handlerCalls, 1);

  const after = await db.inboundWebhook.findUnique({ where: { id: row.id } });
  assert.equal(after.status, 'HANDLED');
  assert.equal(after.handlerError, null, 'old error cleared on successful replay');
});

test('replayInbound: handler throws on retry → stays HANDLER_ERROR with new message', async (t) => {
  const originalHandler = HANDLERS.fonnte;
  HANDLERS.fonnte = async () => { throw new Error('still broken on retry'); };
  t.after(() => { HANDLERS.fonnte = originalHandler; });

  const row = await db.inboundWebhook.create({
    data: {
      source: 'fonnte',
      headers: {},
      payload: '{}',
      signatureValid: null,
      status: 'HANDLER_ERROR',
      handlerError: 'first failure',
    },
  });
  t.after(() => db.inboundWebhook.delete({ where: { id: row.id } }));

  const r = await replayInbound(row.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'handler_threw');

  const after = await db.inboundWebhook.findUnique({ where: { id: row.id } });
  assert.equal(after.status, 'HANDLER_ERROR');
  assert.match(after.handlerError, /still broken on retry/);
});

test('replayInbound: missing id → not_found', async () => {
  const r = await replayInbound('does-not-exist-id-xyz');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});
