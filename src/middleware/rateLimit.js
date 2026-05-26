import { HttpError } from './error.js';

/**
 * Simple in-memory token bucket / sliding window. Fine for single-instance
 * MVP — swap for Redis/express-rate-limit when scaling out.
 */
export function rateLimit({ windowMs, max, key = defaultKey, code = 'RATE_LIMITED' } = {}) {
  if (!windowMs || !max) throw new Error('rateLimit: windowMs and max required');
  const buckets = new Map(); // key → { resetAt, count }

  // periodic GC so memory doesn't grow forever
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref();

  const middleware = (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { resetAt: now + windowMs, count: 0 };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
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
  middleware._gc = gc;
  return middleware;
}

function defaultKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || 'unknown';
  return `${ip}:${req.path}`;
}
