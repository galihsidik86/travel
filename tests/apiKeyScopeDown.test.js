// Stage 124 — scope-down digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { getApiKeyScopeDownCandidates } from '../src/services/apiKeyScopeDown.js';
import { notifyApiKeyScopeDown } from '../src/services/notifications.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

async function seedLog({ apiKeyId, scope, count = 1, ts = new Date() }) {
  for (let i = 0; i < count; i += 1) {
    await db.apiRequestLog.create({
      data: {
        apiKeyId, scope,
        path: '/api/v1/test', method: 'GET',
        statusCode: 200, durationMs: 50, ts,
      },
    });
  }
}

test('getApiKeyScopeDownCandidates: skips zero-traffic keys', async (t) => {
  const tag = makeTag('sd-quiet');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: tag, scopes: ['read:bookings', 'read:audit'],
  });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  const r = await getApiKeyScopeDownCandidates({ days: 30 });
  const found = r.rows.find((x) => x.apiKeyId === k.id);
  assert.equal(found, undefined, 'zero-traffic key must NOT surface');
});

test('getApiKeyScopeDownCandidates: surfaces granted-but-unused scopes', async (t) => {
  const tag = makeTag('sd-unused');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: tag, scopes: ['read:bookings', 'read:audit', 'read:paket'],
  });
  // Only used read:bookings
  await seedLog({ apiKeyId: k.id, scope: 'read:bookings', count: 5 });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  const r = await getApiKeyScopeDownCandidates({ days: 30 });
  const mine = r.rows.find((x) => x.apiKeyId === k.id);
  assert.ok(mine);
  assert.deepEqual(mine.used, ['read:bookings']);
  assert.deepEqual(mine.unused.sort(), ['read:audit', 'read:paket']);
  assert.equal(mine.requestCount, 5);
});

test('getApiKeyScopeDownCandidates: skips keys with all scopes exercised', async (t) => {
  const tag = makeTag('sd-allused');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: tag, scopes: ['read:bookings', 'read:audit'],
  });
  await seedLog({ apiKeyId: k.id, scope: 'read:bookings' });
  await seedLog({ apiKeyId: k.id, scope: 'read:audit' });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  const r = await getApiKeyScopeDownCandidates({ days: 30 });
  const found = r.rows.find((x) => x.apiKeyId === k.id);
  assert.equal(found, undefined, 'fully-utilized key must NOT surface');
});

test('getApiKeyScopeDownCandidates: respects window — old usage doesn\'t save a scope', async (t) => {
  const tag = makeTag('sd-window');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: tag, scopes: ['read:bookings', 'read:audit'],
  });
  // Recent: read:bookings only. Older than window: read:audit (60d ago).
  await seedLog({ apiKeyId: k.id, scope: 'read:bookings' });
  await seedLog({ apiKeyId: k.id, scope: 'read:audit', ts: new Date(Date.now() - 60 * 86_400_000) });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  const r = await getApiKeyScopeDownCandidates({ days: 30 });
  const mine = r.rows.find((x) => x.apiKeyId === k.id);
  assert.ok(mine);
  assert.ok(mine.unused.includes('read:audit'), 'audit was used 60d ago → still unused in 30d window');
});

test('notifyApiKeyScopeDown: silent on empty candidates', async () => {
  const r = await notifyApiKeyScopeDown({ candidates: { rows: [], windowDays: 30 } });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyApiKeyScopeDown: fans out to OWNER+SUPERADMIN, excludes MANAJER_OPS', async (t) => {
  const tag = makeTag('sd-fan');
  const own = await tempUser(t, `${tag}-o`, { role: 'OWNER' });
  const sup = await tempUser(t, `${tag}-s`, { role: 'SUPERADMIN' });
  await tempUser(t, `${tag}-m`, { role: 'MANAJER_OPS' });  // should NOT receive

  t.after(async () => {
    await db.notification.deleteMany({
      where: { type: 'API_KEY_SCOPE_DOWN_OWNER', recipientEmail: { contains: tag } },
    });
  });

  const fake = {
    rows: [{
      apiKeyId: 'demo', name: 'Demo Key', requestCount: 100,
      granted: ['read:bookings', 'read:audit'], used: ['read:bookings'], unused: ['read:audit'],
    }],
    windowDays: 30,
  };
  await notifyApiKeyScopeDown({ candidates: fake });

  const ownNotif = await db.notification.findFirst({ where: { type: 'API_KEY_SCOPE_DOWN_OWNER', recipientEmail: own.email } });
  const supNotif = await db.notification.findFirst({ where: { type: 'API_KEY_SCOPE_DOWN_OWNER', recipientEmail: sup.email } });
  assert.ok(ownNotif);
  assert.ok(supNotif);
  // MANAJER_OPS NOT in the fan set (this is admin tier, smaller than the
  // operational tier).
  const mgrNotif = await db.notification.findFirst({
    where: { type: 'API_KEY_SCOPE_DOWN_OWNER', recipientEmail: { contains: `${tag}-m` } },
  });
  assert.equal(mgrNotif, null, 'MANAJER_OPS must NOT receive scope-down');
});
