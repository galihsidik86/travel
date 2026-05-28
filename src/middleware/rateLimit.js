import { HttpError } from './error.js';
import { makeMemoryStore, makeRedisStore } from '../lib/rateLimitStore.js';
import { env } from '../env.js';

// Module-level singleton store — first rateLimit() call lazily bootstraps it
// based on env. `REDIS_URL` set → Redis (multi-instance safe). Unset → in-
// memory (single-instance only). Override via `setRateLimitStore()` for tests
// or for swapping at runtime.
let store = null;
let storeKind = null;

function getStore() {
  if (store) return store;
  if (env.REDIS_URL) {
    store = makeRedisStore({ url: env.REDIS_URL });
    storeKind = 'redis';
    console.log(`[rateLimit] store = Redis (${env.REDIS_URL.replace(/:\/\/[^@]*@/, '://***@')})`);
  } else {
    store = makeMemoryStore({ windowMs: 60_000 });
    storeKind = 'memory';
    // Quiet — local dev doesn't need the noise. Production deploys should set
    // REDIS_URL; the DEPLOYMENT.md runbook flags this.
  }
  return store;
}

export function setRateLimitStore(s) { store = s; storeKind = s?.kind || null; }
export function getRateLimitStoreKind() { return storeKind || (store?.kind ?? null); }

/** Release the active store (close Redis connection, clear GC interval). Safe to call when no store bootstrapped. */
export async function stopRateLimit() {
  if (!store) return;
  try { await store.stop(); } catch { /* swallow */ }
  store = null;
  storeKind = null;
}

/**
 * Per-bucket rate limiter. `windowMs` + `max` form one bucket; `key` derives
 * the bucket key from the request (default: `ip:path`). `code` is the
 * HttpError code returned on 429.
 *
 * **Fail-open on store errors.** A Redis outage shouldn't lock users out of
 * login. We log + allow; the user sees no rate limit during the outage but
 * also no service interruption.
 */
export function rateLimit({ windowMs, max, key = defaultKey, code = 'RATE_LIMITED' } = {}) {
  if (!windowMs || !max) throw new Error('rateLimit: windowMs and max required');
  return async (req, _res, next) => {
    const s = getStore();
    const k = key(req);
    let count, resetAt;
    try {
      ({ count, resetAt } = await s.hit(k, windowMs));
    } catch (err) {
      console.warn('[rateLimit] store error, failing open:', err.message);
      return next();
    }
    if (count > max) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      return next(
        new HttpError(
          429,
          `Terlalu banyak percobaan. Coba lagi dalam ${retryAfter} detik.`,
          code,
        ),
      );
    }
    next();
  };
}

function defaultKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || 'unknown';
  return `${ip}:${req.path}`;
}
