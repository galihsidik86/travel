// Stage 113 — API keys for partner systems.
//
// Token format: `rp_<id>.<secret>` where `id` is the ApiKey row PK
// (cuid; non-secret) and `secret` is a 32-byte hex string shown once
// at creation. Lookup by id → bcrypt-compare secret. Splitting id from
// secret lets the auth middleware do an O(1) lookup instead of scanning
// every key's hash.
//
// Scopes (JSON array on the row) form a simple capability list. Routes
// declare a required scope; the middleware refuses requests whose key
// doesn't include it. Standard scopes:
//
//   read:bookings    — list / get bookings
//   read:paket       — list paket + landing data
//   read:notifs      — webhook integrations might read delivery state
//
// SUSPENDED status fails auth without deleting the row — admin can
// rotate or revoke without losing the audit trail.

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const KNOWN_SCOPES = ['read:bookings', 'read:paket', 'read:notifs', 'read:audit'];

function generateSecret() {
  return randomBytes(32).toString('hex');
}

export function formatToken(id, secret) {
  return `rp_${id}.${secret}`;
}

function parseToken(raw) {
  if (!raw || !raw.startsWith('rp_')) return null;
  const rest = raw.slice(3);
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  return { id: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

export async function listApiKeys() {
  return db.apiKey.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { createdBy: { select: { email: true } } },
  });
}

export async function createApiKey({ req, actor, name, scopes, rateLimitPerMin }) {
  const cleanName = (name || '').trim().slice(0, 120);
  if (cleanName.length < 2) throw new HttpError(400, 'Nama minimal 2 karakter', 'BAD_NAME');
  const cleanScopes = Array.isArray(scopes)
    ? scopes.filter((s) => KNOWN_SCOPES.includes(s))
    : [];
  if (cleanScopes.length === 0) throw new HttpError(400, 'Pilih minimal satu scope', 'NO_SCOPES');

  // S115 — clamp rate limit. Default 60; allow 1..6000 (max 100/sec).
  let rl = parseInt(rateLimitPerMin, 10);
  if (!Number.isFinite(rl) || rl <= 0) rl = 60;
  rl = Math.min(6000, Math.max(1, rl));

  const secret = generateSecret();
  const hashedKey = await bcrypt.hash(secret, 10);
  const created = await db.apiKey.create({
    data: {
      name: cleanName,
      hashedKey,
      scopes: cleanScopes,
      rateLimitPerMin: rl,
      createdById: actor?.id || null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'ApiKey', entityId: created.id,
    after: { name: cleanName, scopes: cleanScopes, rateLimitPerMin: rl },
  });
  // Return the token ONCE — caller must surface it; the secret is not
  // retrievable afterwards.
  return { ...created, token: formatToken(created.id, secret) };
}

export async function updateApiKeyStatus({ req, actor, id, status }) {
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
    throw new HttpError(400, 'Status tidak valid', 'BAD_STATUS');
  }
  const before = await db.apiKey.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'API key tidak ditemukan', 'KEY_NOT_FOUND');
  if (before.status === status) return before;
  const updated = await db.apiKey.update({ where: { id }, data: { status } });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'ApiKey', entityId: id,
    before: { status: before.status },
    after: { status },
  });
  return updated;
}

export async function deleteApiKey({ req, actor, id }) {
  const before = await db.apiKey.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'API key tidak ditemukan', 'KEY_NOT_FOUND');
  await db.apiKey.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'ApiKey', entityId: id,
    before: { name: before.name, scopes: before.scopes },
  });
  return { id };
}

/**
 * Resolve a `Authorization: Bearer <token>` header to an ApiKey row.
 * Returns null on any failure (bad shape, unknown id, secret mismatch,
 * SUSPENDED status). NEVER throws — the middleware decides how to react.
 *
 * Stamps lastUsedAt on successful resolve (best-effort, doesn't block).
 */
export async function resolveBearerToken(header) {
  if (!header || !header.startsWith('Bearer ')) return null;
  const parsed = parseToken(header.slice(7).trim());
  if (!parsed) return null;
  const row = await db.apiKey.findUnique({ where: { id: parsed.id } });
  if (!row || row.status !== 'ACTIVE') return null;
  const ok = await bcrypt.compare(parsed.secret, row.hashedKey);
  if (!ok) return null;
  // Fire-and-forget — don't block the request on this patch
  db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return row;
}

// Express middleware factory — requires Bearer auth + a specific scope.
// Use BEFORE route handler:
//   router.get('/x', requireApiScope('read:bookings'), apiKeyRateLimit, handler)
export function requireApiScope(scope) {
  return async function apiScopeGuard(req, res, next) {
    const key = await resolveBearerToken(req.headers.authorization || '');
    if (!key) {
      return res.status(401).json({ error: { code: 'BAD_API_KEY', message: 'Invalid or missing API key' } });
    }
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({ error: { code: 'INSUFFICIENT_SCOPE', message: `Requires scope: ${scope}` } });
    }
    req.apiKey = key;
    // S122 — stash the scope this route required so the request-log
    // middleware can record it for per-scope rollup.
    req.apiUsedScope = scope;
    next();
  };
}

/**
 * Stage 121/122 — log every partner API request to ApiRequestLog.
 * Mount at the TOP of /api/v1 (BEFORE auth) so 401s also leave a trail.
 *
 * Captures status + duration in `res.on('finish')` so the row reflects
 * the real outcome. apiKeyId is nullable: failing-auth requests have
 * no resolved key. **Fire-and-forget** — log write failures are caught
 * + printed but never block / delay the request.
 */
export function apiRequestLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const apiKeyId = req.apiKey?.id || null;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
    db.apiRequestLog.create({
      data: {
        apiKeyId,
        path: ((req.baseUrl || '') + (req.path || '')).slice(0, 255),
        method: req.method.slice(0, 10),
        statusCode: res.statusCode || 0,
        durationMs: Date.now() - start,
        scope: req.apiUsedScope || null,
        ip: ip ? ip.slice(0, 45) : null,
      },
    }).catch((err) => {
      console.warn('[apiRequestLog] insert failed:', err?.message || err);
    });
  });
  next();
}

/**
 * Stage 115 — per-API-key rate limit. Runs AFTER requireApiScope (which
 * attaches `req.apiKey`). Reuses the shared rate-limit store so admin
 * can choose in-memory or Redis without touching this middleware.
 *
 * **Fail-open on store errors** — same posture as the human-side rate
 * limit; a Redis blip shouldn't lock partners out. Adds standard
 * `Retry-After` + `X-RateLimit-*` headers so well-behaved clients back
 * off automatically.
 */
export async function apiKeyRateLimit(req, res, next) {
  if (!req.apiKey) {
    return res.status(500).json({ error: { code: 'NO_API_KEY_ATTACHED', message: 'apiKeyRateLimit must run after requireApiScope' } });
  }
  const max = req.apiKey.rateLimitPerMin || 60;
  const windowMs = 60_000;
  let count, resetAt;
  try {
    const { getRateLimitStore } = await import('../middleware/rateLimit.js');
    const store = getRateLimitStore();
    ({ count, resetAt } = await store.hit(`apikey:${req.apiKey.id}`, windowMs));
  } catch (err) {
    console.warn('[apiKeyRateLimit] store error, failing open:', err?.message || err);
    return next();
  }
  if (count > max) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded — ${max} req/min. Retry in ${retryAfter}s.`,
      },
    });
  }
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
  next();
}
