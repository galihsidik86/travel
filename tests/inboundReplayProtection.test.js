// Stage 143 — inbound webhook signature replay protection.
// Per-source opt-in via requireTimestamp:true on hmacVerifier. Stolen
// signed body can't be replayed against us hours later because the
// timestamp is part of the signed payload + verified within 5min skew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { db, makeTag } from './_helpers.js';
import { hmacVerifier, receiveInbound, REPLAY_SKEW_SEC } from '../src/services/inboundWebhooks.js';
import { signWithTimestamp, sign } from '../src/services/webhooks.js';

function makeSig(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

test('hmacVerifier (legacy): no requireTimestamp → no ts check', () => {
  const v = hmacVerifier('TEST_SECRET_LEGACY', 'x-sig');
  process.env.TEST_SECRET_LEGACY = 'secret-1';
  try {
    const body = '{"hello":"world"}';
    const sig = makeSig('secret-1', body);
    const r = v(body, { 'x-sig': 'sha256=' + sig });
    assert.equal(r, true);
  } finally {
    delete process.env.TEST_SECRET_LEGACY;
  }
});

test('hmacVerifier (ts): rejects when X-Webhook-Timestamp missing', () => {
  const v = hmacVerifier('TEST_SECRET_TS_1', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_1 = 'secret-1';
  try {
    const body = '{"hello":"world"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = makeSig('secret-1', `${ts}.${body}`);
    // No x-webhook-timestamp header → reject
    const r = v(body, { 'x-sig': 'sha256=' + sig });
    assert.equal(r, false);
  } finally {
    delete process.env.TEST_SECRET_TS_1;
  }
});

test('hmacVerifier (ts): accepts within 5min skew', () => {
  const v = hmacVerifier('TEST_SECRET_TS_2', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_2 = 'secret-1';
  try {
    const body = '{"hello":"world"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = makeSig('secret-1', `${ts}.${body}`);
    const r = v(body, { 'x-sig': 'sha256=' + sig, 'x-webhook-timestamp': String(ts) });
    assert.equal(r, true);
  } finally {
    delete process.env.TEST_SECRET_TS_2;
  }
});

test('hmacVerifier (ts): rejects timestamp older than 5min (replay attempt)', () => {
  const v = hmacVerifier('TEST_SECRET_TS_3', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_3 = 'secret-1';
  try {
    const body = '{"hello":"world"}';
    // 10 minutes ago — well outside the 5min skew
    const ts = Math.floor(Date.now() / 1000) - 10 * 60;
    const sig = makeSig('secret-1', `${ts}.${body}`);
    const r = v(body, { 'x-sig': 'sha256=' + sig, 'x-webhook-timestamp': String(ts) });
    assert.equal(r, false, '10min-old request → replay rejected');
  } finally {
    delete process.env.TEST_SECRET_TS_3;
  }
});

test('hmacVerifier (ts): rejects future timestamp far outside skew', () => {
  const v = hmacVerifier('TEST_SECRET_TS_4', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_4 = 'secret-1';
  try {
    const body = '{}';
    // 1 hour in the future — clock-running-fast attack or future-replay
    const ts = Math.floor(Date.now() / 1000) + 60 * 60;
    const sig = makeSig('secret-1', `${ts}.${body}`);
    const r = v(body, { 'x-sig': 'sha256=' + sig, 'x-webhook-timestamp': String(ts) });
    assert.equal(r, false);
  } finally {
    delete process.env.TEST_SECRET_TS_4;
  }
});

test('hmacVerifier (ts): rejects when ts is in the signed payload but the header is swapped', () => {
  // Attacker has a captured ts+sig pair. They re-send with the ts in
  // the header swapped to "now" but the signature was computed against
  // the OLD ts. Receiver computes HMAC against the HEADER ts → mismatch.
  const v = hmacVerifier('TEST_SECRET_TS_5', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_5 = 'secret-1';
  try {
    const body = '{}';
    const oldTs = Math.floor(Date.now() / 1000) - 10 * 60;
    const sig = makeSig('secret-1', `${oldTs}.${body}`);
    const nowTs = Math.floor(Date.now() / 1000);
    // Header says NOW (so passes the skew check) but the signature was
    // computed against OLD ts (so HMAC verify fails).
    const r = v(body, { 'x-sig': 'sha256=' + sig, 'x-webhook-timestamp': String(nowTs) });
    assert.equal(r, false, 'ts-swap attempt rejected at HMAC step');
  } finally {
    delete process.env.TEST_SECRET_TS_5;
  }
});

test('hmacVerifier (ts): malformed ts header rejected', () => {
  const v = hmacVerifier('TEST_SECRET_TS_6', 'x-sig', { requireTimestamp: true });
  process.env.TEST_SECRET_TS_6 = 'secret-1';
  try {
    const r = v('{}', { 'x-sig': 'sha256=deadbeef', 'x-webhook-timestamp': 'not-a-number' });
    assert.equal(r, false);
  } finally {
    delete process.env.TEST_SECRET_TS_6;
  }
});

test('signWithTimestamp: matches receiver-side recompute', () => {
  const body = '{"event":"x"}';
  const ts = 1700000000;
  const out = signWithTimestamp('secret-x', body, ts);
  const want = 'sha256=' + createHmac('sha256', 'secret-x').update(`${ts}.${body}`).digest('hex');
  assert.equal(out, want);
});

test('receiveInbound: generic-ts source rejects unsigned/old payloads', async (t) => {
  process.env.WEBHOOK_IN_GENERIC_TS_SECRET = 'ts-secret';
  t.after(() => { delete process.env.WEBHOOK_IN_GENERIC_TS_SECRET; });
  // Old timestamp — replay attempt
  const body = '{"replay":true}';
  const oldTs = Math.floor(Date.now() / 1000) - 30 * 60;
  const sig = makeSig('ts-secret', `${oldTs}.${body}`);
  const r = await receiveInbound({
    source: 'generic-ts',
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'x-religio-signature': 'sha256=' + sig,
      'x-webhook-timestamp': String(oldTs),
    },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  assert.equal(r.status, 'REJECTED', 'old replay → rejected');
  assert.equal(r.signatureValid, false);
});

test('receiveInbound: generic-ts source accepts fresh signed payload', async (t) => {
  process.env.WEBHOOK_IN_GENERIC_TS_SECRET = 'ts-secret-2';
  t.after(() => { delete process.env.WEBHOOK_IN_GENERIC_TS_SECRET; });
  const body = '{"fresh":true}';
  const ts = Math.floor(Date.now() / 1000);
  const sig = makeSig('ts-secret-2', `${ts}.${body}`);
  const r = await receiveInbound({
    source: 'generic-ts',
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'x-religio-signature': 'sha256=' + sig,
      'x-webhook-timestamp': String(ts),
    },
  });
  t.after(async () => { if (r.id) await db.inboundWebhook.delete({ where: { id: r.id } }); });

  assert.equal(r.signatureValid, true, 'fresh signed request accepted');
});

test('REPLAY_SKEW_SEC: exported constant matches Stripe-style 5min', () => {
  assert.equal(REPLAY_SKEW_SEC, 300);
});
