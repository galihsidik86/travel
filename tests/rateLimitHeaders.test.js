// Stage 125 — X-RateLimit-* + Retry-After on human-facing rate-limited routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rateLimit, setRateLimitStore } from '../src/middleware/rateLimit.js';
import { makeMemoryStore } from '../src/lib/rateLimitStore.js';

function makeReq() {
  return { headers: {}, ip: '127.0.0.1', path: '/x' };
}
function makeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

test('rateLimit: under-limit sets X-RateLimit-* headers + calls next', async (t) => {
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const req = makeReq();
  const res = makeRes();
  let called = false;
  await mw(req, res, (err) => { if (err) throw err; called = true; });
  assert.equal(called, true);
  assert.equal(res.headers['x-ratelimit-limit'], '3');
  assert.equal(res.headers['x-ratelimit-remaining'], '2', 'first call: 3-1=2 remaining');
  assert.ok(res.headers['x-ratelimit-reset']);
  assert.equal(res.headers['retry-after'], undefined, 'no Retry-After under limit');
});

test('rateLimit: over-limit sets Retry-After + next(err) with HttpError', async (t) => {
  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));

  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  // Hit twice — second call should 429
  let firstErr = null, secondErr = null;
  const req = makeReq();
  await mw(req, makeRes(), (err) => { firstErr = err; });
  assert.equal(firstErr, undefined, 'first call passes');

  const res = makeRes();
  await mw(req, res, (err) => { secondErr = err; });
  assert.ok(secondErr, 'second call hits limit');
  assert.equal(secondErr.status, 429);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
  assert.ok(res.headers['retry-after'], 'Retry-After present on 429');
  // Numeric and sane
  const ra = parseInt(res.headers['retry-after'], 10);
  assert.ok(ra > 0 && ra <= 60, `Retry-After in seconds, got ${ra}`);
});

test('rateLimit: store error → fail open + no headers set', async (t) => {
  // Inject a broken store so .hit throws
  setRateLimitStore({
    kind: 'broken',
    hit: async () => { throw new Error('boom'); },
    stop: async () => {},
  });
  t.after(() => setRateLimitStore(null));

  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const res = makeRes();
  let called = false;
  await mw(makeReq(), res, (err) => { if (err) throw err; called = true; });
  assert.equal(called, true, 'still calls next when store breaks');
  // Headers NOT set (we have no count to report)
  assert.equal(res.headers['x-ratelimit-limit'], undefined);
});
