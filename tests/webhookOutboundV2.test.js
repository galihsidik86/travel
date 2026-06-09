// Stage 143 — outbound webhooks include X-Webhook-Timestamp +
// X-Religio-Signature-V2 (timestamped) alongside the legacy
// X-Religio-Signature so partners can opt into replay protection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createWebhook, dispatchEvent } from '../src/services/webhooks.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

test('outbound: includes X-Webhook-Timestamp + V2 signature header', async (t) => {
  const tag = makeTag('s143-out');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const wh = await createWebhook({
    req: fakeReq, actor: actor(u),
    url: 'https://test.example/v2', events: ['booking.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const original = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: opts.body };
    return { status: 200, ok: true };
  };
  t.after(() => { global.fetch = original; });

  await dispatchEvent('booking.created', { bookingId: 'x1' });

  assert.ok(captured, 'fetch called');
  // Legacy + V2 BOTH present so opt-in partners can pick up replay protection
  assert.ok(captured.headers['X-Religio-Signature'], 'legacy signature header still set');
  assert.ok(captured.headers['X-Religio-Signature-V2'], 'V2 timestamped signature present');
  assert.ok(captured.headers['X-Webhook-Timestamp'], 'X-Webhook-Timestamp present');

  // Verify the V2 signature checks out for partners doing the recompute
  const ts = parseInt(captured.headers['X-Webhook-Timestamp'], 10);
  assert.ok(Number.isFinite(ts) && ts > 0);
  const want = 'sha256=' + createHmac('sha256', wh.secret).update(`${ts}.${captured.body}`).digest('hex');
  assert.equal(captured.headers['X-Religio-Signature-V2'], want);

  // Timestamp is "now-ish" — within a 30s window of test execution
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(nowSec - ts) <= 30, 'ts is current');
});
