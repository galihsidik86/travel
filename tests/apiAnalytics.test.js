// Stage 121/122 — ApiRequestLog + per-key analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempUser, tempJemaah, tempPaket, tempBooking, fakeReq } from './_helpers.js';
import { createApp } from '../src/app.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { getApiKeyAnalytics } from '../src/services/apiAnalytics.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}
function close(srv) { return new Promise((r) => srv.close(r)); }
function req(srv, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = srv.address();
    const r = http.request({ hostname: '127.0.0.1', port: addr.port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    r.on('error', reject);
    r.end();
  });
}

// res.on('finish') is async — give it a tick to land in the DB.
function tick() { return new Promise((r) => setTimeout(r, 100)); }

test('apiRequestLog: records every call with status + duration + scope', async (t) => {
  const tag = makeTag('rl-record');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:bookings'],
  });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  const srv = await startServer();
  try {
    await req(srv, 'GET', '/api/v1/bookings?limit=1', { Authorization: 'Bearer ' + k.token });
    await tick();

    const logs = await db.apiRequestLog.findMany({ where: { apiKeyId: k.id } });
    assert.ok(logs.length >= 1);
    const last = logs[logs.length - 1];
    assert.equal(last.method, 'GET');
    assert.equal(last.statusCode, 200);
    assert.equal(last.scope, 'read:bookings', 'scope captured');
    assert.ok(last.durationMs >= 0);
    assert.match(last.path, /\/api\/v1\/bookings/);
  } finally { await close(srv); }
});

test('apiRequestLog: failing-auth requests also logged (apiKeyId=null)', async (t) => {
  const srv = await startServer();
  try {
    await req(srv, 'GET', '/api/v1/bookings');  // no auth → 401
    await tick();
    const logs = await db.apiRequestLog.findMany({
      where: { apiKeyId: null, path: { contains: '/bookings' } },
      orderBy: { ts: 'desc' }, take: 1,
    });
    assert.ok(logs.length >= 1);
    assert.equal(logs[0].statusCode, 401);
    assert.equal(logs[0].apiKeyId, null);
    assert.equal(logs[0].scope, null, '401 has no scope (failed before requireApiScope set it)');
    // Don't clean up — leaving the row in place is fine (FK-less).
  } finally { await close(srv); }
});

test('getApiKeyAnalytics: rolls up per-key with scope split + unused scopes flagged', async (t) => {
  const tag = makeTag('rl-analytics');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  // Grant TWO scopes but use only ONE — unused scope should surface
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:bookings', 'read:audit'],
  });
  t.after(async () => {
    await db.apiRequestLog.deleteMany({ where: { apiKeyId: k.id } });
    await db.apiKey.deleteMany({ where: { id: k.id } });
  });

  // Seed mixed log rows directly (faster than spinning real requests)
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push({ apiKeyId: k.id, path: '/api/v1/bookings', method: 'GET', statusCode: 200, durationMs: 50 + i * 10, scope: 'read:bookings', ts: now });
  rows.push({ apiKeyId: k.id, path: '/api/v1/bookings', method: 'GET', statusCode: 500, durationMs: 120, scope: 'read:bookings', ts: now });
  for (const r of rows) await db.apiRequestLog.create({ data: r });

  const out = await getApiKeyAnalytics({ days: 7 });
  const mine = out.rows.find((r) => r.apiKeyId === k.id);
  assert.ok(mine, 'key appears in analytics');
  assert.equal(mine.requests, 6);
  assert.equal(mine.errors5xx, 1);
  assert.ok(mine.p95DurationMs >= 90);
  // Used: read:bookings; granted but unused: read:audit
  const usedScopes = mine.scopeUsage.map((s) => s.scope);
  assert.deepEqual(usedScopes, ['read:bookings']);
  assert.ok(mine.unusedScopes.includes('read:audit'), 'unused scope flagged');
});

test('getApiKeyAnalytics: omits keys with zero logged traffic', async (t) => {
  const tag = makeTag('rl-quiet');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const quietKey = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: quietKey.id } }));

  const out = await getApiKeyAnalytics({ days: 7 });
  const found = out.rows.find((r) => r.apiKeyId === quietKey.id);
  assert.equal(found, undefined, 'zero-traffic key not in analytics rows');
});
