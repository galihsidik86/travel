// Rate-limit storage abstraction. Two implementations:
//
//   - in-memory:  fixed-window bucket per key. Single-instance only.
//   - Redis:      INCR + PEXPIRE via MULTI for atomic counter + window TTL.
//                 Safe across multiple app instances.
//
// Store contract:
//   hit(key, windowMs) → { count, resetAt }
//     count   — total hits in the current window (incl. this one)
//     resetAt — epoch ms when the window resets
//
//   stop() — release any background timers / connections (idempotent)
//
// The middleware decides "allowed" by comparing count to its own max —
// keeps the store pure-counting and reusable for multiple buckets.
import { createClient } from 'redis';

export function makeMemoryStore({ windowMs } = {}) {
  const buckets = new Map();
  // GC interval = window length (same cadence as old impl). `unref()` so it
  // doesn't keep the process alive in tests.
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs || 60_000).unref();

  return {
    kind: 'memory',
    async hit(key, ttlMs) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { resetAt: now + ttlMs, count: 0 };
        buckets.set(key, b);
      }
      b.count++;
      return { count: b.count, resetAt: b.resetAt };
    },
    async stop() {
      clearInterval(gc);
    },
  };
}

/**
 * Build a Redis-backed store. `url` is e.g. redis://localhost:6379 or rediss://
 * for TLS. The client connects lazily on first hit; failures bubble up so the
 * middleware can fail-open + log.
 */
export function makeRedisStore({ url, keyPrefix = 'rl:' } = {}) {
  if (!url) throw new Error('makeRedisStore: url required');

  const client = createClient({ url });
  let connectPromise = null;
  client.on('error', (err) => {
    // Quiet log — middleware fails-open per-request; one boot-time noise line is enough
    if (!client._loggedFirstError) {
      client._loggedFirstError = true;
      console.warn('[rateLimit:redis] client error:', err.message);
    }
  });

  async function ensureConnected() {
    if (client.isOpen) return;
    if (!connectPromise) connectPromise = client.connect().catch((err) => {
      connectPromise = null; // allow retry on next call
      throw err;
    });
    await connectPromise;
  }

  return {
    kind: 'redis',
    async hit(key, ttlMs) {
      await ensureConnected();
      const k = `${keyPrefix}${key}`;
      // MULTI gives atomic ordering of the two ops. INCR returns the new count;
      // pTTL tells us whether we need to set the window TTL (only on first hit
      // OR if the key somehow lost its TTL — defensive).
      const tx = client.multi().incr(k).pTTL(k);
      const [count, ttl] = await tx.exec();
      let resetAt;
      if (ttl < 0) {
        // -1 = key has no TTL (brand new from our INCR); -2 = key expired
        // between INCR and pTTL (race; rare). Either way, set TTL.
        await client.pExpire(k, ttlMs);
        resetAt = Date.now() + ttlMs;
      } else {
        resetAt = Date.now() + ttl;
      }
      return { count: Number(count), resetAt };
    },
    async stop() {
      if (client.isOpen) await client.quit().catch(() => {});
    },
  };
}
