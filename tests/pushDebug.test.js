import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempUser } from './_helpers.js';
import {
  subscribePush, listAllPushSubscriptionsForDebug, sendTestPushToSubscription,
} from '../src/services/webPush.js';

async function makeSub(t, userId, tag) {
  const sub = await subscribePush({
    userId,
    subscription: {
      endpoint: `https://example.test/push/${tag}-${Math.random().toString(36).slice(2)}`,
      keys: { p256dh: 'a'.repeat(80), auth: 'b'.repeat(20) },
    },
    userAgent: 'TestAgent/1.0',
  });
  t.after(() => db.pushSubscription.deleteMany({ where: { id: sub.id } }));
  return sub;
}

test('listAllPushSubscriptionsForDebug: returns rows with user info', async (t) => {
  const tag = makeTag('pd-list');
  const u = await tempUser(t, `${tag}-o`, { role: 'OWNER' });
  const sub = await makeSub(t, u.id, tag);

  const all = await listAllPushSubscriptionsForDebug();
  const mine = all.find((s) => s.id === sub.id);
  assert.ok(mine);
  assert.equal(mine.user.id, u.id);
  assert.equal(mine.user.role, 'OWNER');
  assert.ok(mine.endpointPreview.endsWith('…'));
  assert.equal(mine.stale, false);
});

test('listAllPushSubscriptionsForDebug: flags suspended user as stale', async (t) => {
  const tag = makeTag('pd-stale');
  const u = await tempUser(t, `${tag}-s`, { role: 'OWNER', status: 'SUSPENDED' });
  const sub = await makeSub(t, u.id, tag);

  const all = await listAllPushSubscriptionsForDebug();
  const mine = all.find((s) => s.id === sub.id);
  assert.ok(mine);
  assert.equal(mine.stale, true);
});

test('sendTestPushToSubscription: succeeds in fake mode', async (t) => {
  const tag = makeTag('pd-send');
  const j = await tempJemaah(t, tag);
  const sub = await makeSub(t, j.id, tag);

  const r = await sendTestPushToSubscription(sub.id);
  assert.ok(r.ok, 'fake mode should return ok:true');
  // status is 'fake' in fake mode, 'sent' in real mode
  assert.ok(r.status === 'fake' || r.status === 'sent');
});

test('sendTestPushToSubscription: returns not_found for unknown id', async () => {
  const r = await sendTestPushToSubscription('nonexistent-sub-id-xyz');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'not_found');
});
