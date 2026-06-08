// Stage 115 — per-API-key rate limit middleware.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { createApiKey, apiKeyRateLimit } from '../src/services/apiKeys.js';
import { setRateLimitStore } from '../src/middleware/rateLimit.js';
import { makeMemoryStore } from '../src/lib/rateLimitStore.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

function makeRes() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return {
    done: p,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; resolve(); return this; },
  };
}

test('apiKeyRateLimit: rejects with 500 when req.apiKey missing (mounted wrong)', async () => {
  const res = makeRes();
  await apiKeyRateLimit({}, res, () => res.json({}));
  assert.equal(res._status, 500);
});

test('apiKeyRateLimit: allows under-limit + populates X-RateLimit headers', async (t) => {
  // Fresh in-memory store so other tests don't poison the counter.
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const tag = makeTag('rl-ok');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag,
    scopes: ['read:bookings'], rateLimitPerMin: 5,
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  let called = 0;
  const res = makeRes();
  await apiKeyRateLimit({ apiKey: k }, res, () => { called += 1; });
  assert.equal(called, 1, 'next() called under limit');
  assert.equal(res.headers['x-ratelimit-limit'], '5');
  assert.equal(res.headers['x-ratelimit-remaining'], '4');
});

test('apiKeyRateLimit: 429 when over limit + Retry-After set', async (t) => {
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const tag = makeTag('rl-over');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag,
    scopes: ['read:bookings'], rateLimitPerMin: 2,
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  // Burn through the limit
  for (let i = 0; i < 2; i += 1) {
    const res = makeRes();
    let called = 0;
    await apiKeyRateLimit({ apiKey: k }, res, () => { called += 1; });
    assert.equal(called, 1, `hit ${i + 1} under limit`);
  }

  // Third hit → 429
  const res = makeRes();
  let called = 0;
  await apiKeyRateLimit({ apiKey: k }, res, () => { called += 1; });
  await res.done;
  assert.equal(called, 0, 'next() NOT called when over');
  assert.equal(res._status, 429);
  assert.equal(res._body.error.code, 'RATE_LIMITED');
  assert.ok(res.headers['retry-after']);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
});

test('apiKeyRateLimit: scopes per-key — different keys have independent buckets', async (t) => {
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const tag = makeTag('rl-isolated');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k1 = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag + '-1',
    scopes: ['read:bookings'], rateLimitPerMin: 1,
  });
  const k2 = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag + '-2',
    scopes: ['read:bookings'], rateLimitPerMin: 1,
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: { in: [k1.id, k2.id] } } }));

  // k1 burns its 1-req budget
  let res = makeRes();
  await apiKeyRateLimit({ apiKey: k1 }, res, () => {});
  // k2 should still have its budget
  res = makeRes();
  let called = 0;
  await apiKeyRateLimit({ apiKey: k2 }, res, () => { called += 1; });
  assert.equal(called, 1, 'k2 has its own bucket');
});

test('createApiKey: clamps rateLimitPerMin to [1..6000]', async (t) => {
  const tag = makeTag('rl-clamp');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  // negative → default 60
  const k1 = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag + '-neg',
    scopes: ['read:bookings'], rateLimitPerMin: -5,
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k1.id } }));
  assert.equal(k1.rateLimitPerMin, 60);

  // over cap → 6000
  const k2 = await createApiKey({
    req: fakeReq, actor: actor(u), name: tag + '-huge',
    scopes: ['read:bookings'], rateLimitPerMin: 999999,
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k2.id } }));
  assert.equal(k2.rateLimitPerMin, 6000);
});
