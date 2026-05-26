// Production sender adapter tests (5kk). Pure unit — no DB, no network.
// Mocks global fetch to verify Fonnte client behavior end-to-end.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeFonnteSender } from '../src/lib/senders/fonnte.js';
import { makeSmtpSender } from '../src/lib/senders/smtp.js';
import { bootstrapNotifSenders, _resetForTests } from '../src/lib/notifBootstrap.js';

describe('makeFonnteSender', () => {
  test('throws when token missing', () => {
    assert.throws(() => makeFonnteSender({}), /token required/);
  });

  describe('with stubbed fetch', () => {
    const sender = makeFonnteSender({ token: 'tk', baseUrl: 'https://fonn.example' });
    let originalFetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('skip when no recipient phone', async () => {
      const r = await sender({ recipientPhone: '', body: 'x' });
      assert.equal(r.skip, true);
      assert.match(r.reason, /phone/);
    });

    test('success path: normalises phone + merges subject and body', async () => {
      let captured = null;
      globalThis.fetch = async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ status: true }), { status: 200 });
      };
      const r = await sender({ recipientPhone: '0812-3456-7890', subject: 'Hi', body: 'Hello' });
      assert.equal(r.ok, true);
      assert.equal(captured.url, 'https://fonn.example/send');
      assert.equal(captured.init.headers.Authorization, 'tk');
      const body = new URLSearchParams(captured.init.body);
      assert.equal(body.get('target'), '6281234567890', 'leading 0 swapped to 62');
      assert.match(body.get('message'), /Hi/);
      assert.match(body.get('message'), /Hello/);
    });

    test('Fonnte 200 + status:false surfaces reason as error', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({
        status: false, reason: 'quota exceeded',
      }), { status: 200 });
      const r = await sender({ recipientPhone: '0812', body: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.error, /quota exceeded/);
    });

    test('network failure surfaces as error', async () => {
      globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
      const r = await sender({ recipientPhone: '0812', body: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.error, /ECONNREFUSED/);
    });

    test('HTTP non-200 surfaces status code in error', async () => {
      globalThis.fetch = async () => new Response('Server Error', { status: 500 });
      const r = await sender({ recipientPhone: '0812', body: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.error, /HTTP 500/);
    });
  });
});

describe('makeSmtpSender', () => {
  test('throws when host missing', () => {
    assert.throws(() => makeSmtpSender({ from: 'a@b' }), /host required/);
  });
  test('throws when from missing', () => {
    assert.throws(() => makeSmtpSender({ host: 'smtp.example' }), /from required/);
  });
  test('returns a callable sender when args valid', () => {
    const send = makeSmtpSender({ host: 'smtp.example', from: 'a@b' });
    assert.equal(typeof send, 'function');
  });
});

describe('bootstrapNotifSenders', () => {
  test('idempotent — repeated calls return same shape', () => {
    _resetForTests();
    const r1 = bootstrapNotifSenders();
    const r2 = bootstrapNotifSenders();
    assert.equal(typeof r1.wa, 'boolean');
    assert.equal(typeof r1.email, 'boolean');
    assert.equal(r1.wa, r2.wa);
    assert.equal(r1.email, r2.email);
  });
});
