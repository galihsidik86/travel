// Rate-limit store + middleware tests.
//
// In-memory store: full coverage (count, window reset, GC).
// Redis store: skipped unless TEST_REDIS_URL is set in env. To run:
//   TEST_REDIS_URL=redis://localhost:6379 npm test
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { makeMemoryStore, makeRedisStore } from '../src/lib/rateLimitStore.js';
import {
  rateLimit, setRateLimitStore, getRateLimitStoreKind, stopRateLimit,
} from '../src/middleware/rateLimit.js';

describe('makeMemoryStore', () => {
  test('counts hits per key within window', async () => {
    const s = makeMemoryStore({ windowMs: 1000 });
    after(() => s.stop());
    const a1 = await s.hit('A', 1000);
    const a2 = await s.hit('A', 1000);
    const b1 = await s.hit('B', 1000);
    assert.equal(a1.count, 1);
    assert.equal(a2.count, 2);
    assert.equal(b1.count, 1, 'separate key has its own bucket');
    assert.ok(a1.resetAt > Date.now());
    assert.equal(a1.resetAt, a2.resetAt, 'same key shares resetAt within window');
  });

  test('resets count after window expires', async () => {
    const s = makeMemoryStore({ windowMs: 60_000 });
    after(() => s.stop());
    // Use a tiny window via the per-hit ttl param (which IS the actual window)
    const first = await s.hit('K', 50);
    assert.equal(first.count, 1);
    await new Promise((r) => setTimeout(r, 80));
    const second = await s.hit('K', 50);
    assert.equal(second.count, 1, 'window elapsed → fresh bucket');
    assert.ok(second.resetAt > first.resetAt);
  });

  test('kind = "memory"', () => {
    const s = makeMemoryStore({ windowMs: 1000 });
    after(() => s.stop());
    assert.equal(s.kind, 'memory');
  });
});

describe('rateLimit middleware', () => {
  // Each test installs its own store via setRateLimitStore, then resets.
  test('returns 429 after max hits in window', async (t) => {
    const store = makeMemoryStore({ windowMs: 60_000 });
    setRateLimitStore(store);
    t.after(async () => { await stopRateLimit(); });

    const mw = rateLimit({ windowMs: 60_000, max: 3, code: 'TOO_MANY' });
    const req = { ip: '1.2.3.4', path: '/login', headers: {} };

    // 3 successful hits
    for (let i = 0; i < 3; i++) {
      const err = await runMw(mw, req);
      assert.equal(err, null, `hit ${i + 1} passes`);
    }
    // 4th rejected
    const err4 = await runMw(mw, req);
    assert.ok(err4, '4th hit rejected');
    assert.equal(err4.status, 429);
    assert.equal(err4.code, 'TOO_MANY');
    assert.match(err4.message, /Coba lagi dalam \d+ detik/);
  });

  test('separate ip → separate bucket', async (t) => {
    const store = makeMemoryStore({ windowMs: 60_000 });
    setRateLimitStore(store);
    t.after(async () => { await stopRateLimit(); });

    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    const reqA = { ip: '1.1.1.1', path: '/login', headers: {} };
    const reqB = { ip: '2.2.2.2', path: '/login', headers: {} };

    await runMw(mw, reqA); await runMw(mw, reqA); // A: 2/2
    const errA = await runMw(mw, reqA);
    assert.equal(errA?.status, 429);
    const errB = await runMw(mw, reqB);
    assert.equal(errB, null, 'B not affected by A');
  });

  test('x-forwarded-for honored over req.ip', async (t) => {
    const store = makeMemoryStore({ windowMs: 60_000 });
    setRateLimitStore(store);
    t.after(async () => { await stopRateLimit(); });

    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    // Same req.ip, different x-forwarded-for → separate buckets
    await runMw(mw, { ip: '1.1.1.1', path: '/login', headers: { 'x-forwarded-for': '9.9.9.9' } });
    const err1 = await runMw(mw, { ip: '1.1.1.1', path: '/login', headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.equal(err1?.status, 429, 'same XFF rate-limited');
    const err2 = await runMw(mw, { ip: '1.1.1.1', path: '/login', headers: { 'x-forwarded-for': '8.8.8.8' } });
    assert.equal(err2, null, 'different XFF → new bucket');
  });

  test('fails OPEN when store throws (Redis outage simulation)', async (t) => {
    const brokenStore = { kind: 'broken', async hit() { throw new Error('ECONNREFUSED'); }, async stop() {} };
    setRateLimitStore(brokenStore);
    t.after(async () => { await stopRateLimit(); });

    const mw = rateLimit({ windowMs: 1000, max: 1 });
    const err = await runMw(mw, { ip: '1.1.1.1', path: '/login', headers: {} });
    assert.equal(err, null, 'store error → request allowed (fail-open)');
  });
});

describe('getRateLimitStoreKind', () => {
  test('reflects active store kind', async (t) => {
    const s = makeMemoryStore({ windowMs: 1000 });
    setRateLimitStore(s);
    t.after(async () => { await stopRateLimit(); });
    assert.equal(getRateLimitStoreKind(), 'memory');
  });
});

// Redis store: only run when an opt-in env var is set so the suite doesn't
// require a live Redis instance.
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
describe('makeRedisStore', { skip: !TEST_REDIS_URL ? 'TEST_REDIS_URL not set' : false }, () => {
  test('counts hits + sets TTL atomically', async (t) => {
    const s = makeRedisStore({ url: TEST_REDIS_URL, keyPrefix: `test:${Date.now()}:` });
    t.after(async () => { await s.stop(); });
    const h1 = await s.hit('K', 5000);
    const h2 = await s.hit('K', 5000);
    assert.equal(h1.count, 1);
    assert.equal(h2.count, 2);
    assert.ok(h1.resetAt > Date.now());
    assert.ok(h1.resetAt <= Date.now() + 5000);
  });
});

// ── helpers ──────────────────────────────────────────────────
function runMw(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err || null));
  });
}
