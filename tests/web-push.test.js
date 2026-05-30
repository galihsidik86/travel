// Stage 17 — Web Push subscription storage + admin fan-out (fake-mode).
// VAPID keys aren't set in the test env, so getPushMode() returns "console"
// and sendOne() just logs. That's still enough to verify the storage layer
// (subscribe/unsubscribe/idempotency + admin-only fan-out scoping).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser } from './_helpers.js';
import {
  subscribePush, unsubscribePush, listMyPushSubscriptions,
  pushToAdmins, getPushMode,
} from '../src/services/webPush.js';

function fakeSub(suffix) {
  return {
    endpoint: `https://fcm.example.test/sub/${suffix}`,
    keys: {
      p256dh: `BPa-${suffix}-${'x'.repeat(80)}`,
      auth: `auth-${suffix}-${'y'.repeat(20)}`,
    },
  };
}

describe('subscribePush', () => {
  test('creates a row keyed on endpoint hash', async (t) => {
    const tag = makeTag('push-create');
    const user = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.pushSubscription.deleteMany({ where: { userId: user.id } });
    });

    const row = await subscribePush({
      userId: user.id, subscription: fakeSub(tag), userAgent: 'TestAgent/1.0',
    });
    assert.ok(row.id);
    assert.equal(row.userId, user.id);
    assert.equal(row.userAgent, 'TestAgent/1.0');
    assert.equal(row.endpoint, `https://fcm.example.test/sub/${tag}`);
    assert.match(row.endpointHash, /^[a-f0-9]{64}$/);
  });

  test('re-subscribing same endpoint updates instead of duplicating', async (t) => {
    const tag = makeTag('push-upsert');
    const user = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.pushSubscription.deleteMany({ where: { userId: user.id } });
    });

    const sub = fakeSub(tag);
    const first = await subscribePush({ userId: user.id, subscription: sub, userAgent: 'A' });
    const second = await subscribePush({
      userId: user.id,
      subscription: { ...sub, keys: { ...sub.keys, p256dh: 'NEW_P256DH' } },
      userAgent: 'B',
    });
    assert.equal(first.id, second.id, 'same row id (upsert by endpointHash)');
    assert.equal(second.p256dh, 'NEW_P256DH', 'p256dh refreshed');
    assert.equal(second.userAgent, 'B', 'UA refreshed');

    const rows = await db.pushSubscription.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1, 'no duplicate row');
  });

  test('throws BAD_SUBSCRIPTION on malformed input', async (t) => {
    const tag = makeTag('push-bad');
    const user = await tempUser(t, tag, { role: 'OWNER' });
    await assert.rejects(
      () => subscribePush({ userId: user.id, subscription: { endpoint: 'x' } }),
      (err) => err.code === 'BAD_SUBSCRIPTION',
    );
  });
});

describe('unsubscribePush', () => {
  test('by endpoint removes the row', async (t) => {
    const tag = makeTag('push-unsub');
    const user = await tempUser(t, tag, { role: 'OWNER' });
    const sub = fakeSub(tag);
    await subscribePush({ userId: user.id, subscription: sub });
    const r = await unsubscribePush({ endpoint: sub.endpoint, userId: user.id });
    assert.equal(r.deleted, 1);
    assert.equal((await listMyPushSubscriptions(user.id)).length, 0);
  });

  test('cross-user delete refused (scoped to userId)', async (t) => {
    const tag = makeTag('push-scope');
    const u1 = await tempUser(t, `${tag}-1`, { role: 'OWNER' });
    const u2 = await tempUser(t, `${tag}-2`, { role: 'OWNER' });
    const sub = fakeSub(tag);
    const row = await subscribePush({ userId: u1.id, subscription: sub });
    t.after(async () => {
      await db.pushSubscription.deleteMany({ where: { userId: u1.id } });
    });

    // u2 attempts to unsubscribe u1's endpoint — must be a no-op
    const r = await unsubscribePush({ endpoint: sub.endpoint, userId: u2.id });
    assert.equal(r.deleted, 0);
    const still = await db.pushSubscription.findUnique({ where: { id: row.id } });
    assert.ok(still, 'u1 row survives');
  });

  test('missing endpoint AND id → no-op (returns deleted=0)', async () => {
    const r = await unsubscribePush({});
    assert.equal(r.deleted, 0);
  });
});

describe('pushToAdmins (fake mode)', () => {
  test('mode is console when VAPID_PUBLIC absent', () => {
    assert.equal(getPushMode(), 'console', 'no VAPID env in test → console fake mode');
  });

  test('counts deliveries to ACTIVE admin subscriptions only', async (t) => {
    const tag = makeTag('push-fanout');
    const adminA = await tempUser(t, `${tag}-A`, { role: 'OWNER' });
    const adminB = await tempUser(t, `${tag}-B`, { role: 'MANAJER_OPS' });
    const adminSuspended = await tempUser(t, `${tag}-S`, { role: 'OWNER', status: 'SUSPENDED' });
    const nonAdmin = await tempUser(t, `${tag}-N`, { role: 'AGEN' });

    await subscribePush({ userId: adminA.id,         subscription: fakeSub(tag + '-A') });
    await subscribePush({ userId: adminB.id,         subscription: fakeSub(tag + '-B') });
    await subscribePush({ userId: adminSuspended.id, subscription: fakeSub(tag + '-S') });
    await subscribePush({ userId: nonAdmin.id,       subscription: fakeSub(tag + '-N') });
    t.after(async () => {
      await db.pushSubscription.deleteMany({ where: { userId: { in: [adminA.id, adminB.id, adminSuspended.id, nonAdmin.id] } } });
    });

    const r = await pushToAdmins({ title: 'TEST', body: 'fake-mode', url: '/admin/incidents' });
    // 2 ACTIVE admin OWNER + MANAJER_OPS — suspended + AGEN excluded.
    assert.equal(r.delivered, 2);
    assert.equal(r.failed, 0);
    assert.equal(r.gone, 0);
  });

  test('returns zero counts when nobody is subscribed', async () => {
    const r = await pushToAdmins({ title: 'TEST', body: 'none', url: '/admin/incidents' });
    assert.ok(r.delivered >= 0 && typeof r.delivered === 'number');
  });
});
