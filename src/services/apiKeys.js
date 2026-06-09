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

export async function createApiKey({ req, actor, name, scopes, rateLimitPerMin, allowedIps }) {
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

  // S135 — normalise CIDR allowlist (accept string with comma/newline
  // separation OR an array). Empty result → null = "any IP".
  const cleanAllowedIps = normaliseAllowedIps(allowedIps);

  const secret = generateSecret();
  const hashedKey = await bcrypt.hash(secret, 10);
  const created = await db.apiKey.create({
    data: {
      name: cleanName,
      hashedKey,
      scopes: cleanScopes,
      rateLimitPerMin: rl,
      allowedIps: cleanAllowedIps,
      createdById: actor?.id || null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'ApiKey', entityId: created.id,
    after: { name: cleanName, scopes: cleanScopes, rateLimitPerMin: rl, allowedIps: cleanAllowedIps },
  });
  // Return the token ONCE — caller must surface it; the secret is not
  // retrievable afterwards.
  return { ...created, token: formatToken(created.id, secret) };
}

/**
 * Stage 135 — normalise the admin's CIDR input into a clean JSON array
 * or null. Accepts:
 *   - string: comma/newline-separated entries → array
 *   - array: passed through with trim + filter
 *   - empty/null/undefined → null (= any IP)
 *
 * Entries are NOT validated for parseability here — `ipMatchesAllowlist`
 * silently ignores malformed strings on lookup. A typo'd entry that
 * never matches will surface as "I keep getting 403s" during onboarding,
 * which is the right time to discover it; preventing save with a brittle
 * validator costs more than it saves.
 */
export function normaliseAllowedIps(input) {
  if (input == null || input === '') return null;
  let list;
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[,\n]/);
  else return null;
  const cleaned = list
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0)
    .slice(0, 50);  // hard cap so a paste-bomb can't bloat the row
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Stage 135 — admin updates a key's IP allowlist. No-op + skip-audit
 * when the value didn't change (cleaned arrays compared as JSON strings).
 */
export async function updateApiKeyAllowedIps({ req, actor, id, allowedIps }) {
  const before = await db.apiKey.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'API key tidak ditemukan', 'KEY_NOT_FOUND');
  const cleaned = normaliseAllowedIps(allowedIps);
  // JSON-string compare handles both null and array shapes
  if (JSON.stringify(before.allowedIps ?? null) === JSON.stringify(cleaned)) {
    return before;
  }
  const updated = await db.apiKey.update({
    where: { id }, data: { allowedIps: cleaned },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'ApiKey', entityId: id,
    before: { allowedIps: before.allowedIps },
    after:  { allowedIps: cleaned },
  });
  return updated;
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
    // Stage 135 — IP allowlist check. Empty / null = any IP (back-compat
    // with every pre-S135 row). When configured, the request IP must
    // match at least one entry (exact IP or CIDR). Mismatch → 403
    // IP_NOT_ALLOWED (NOT 401 — the token IS valid, the source just
    // isn't authorised).
    const allowed = Array.isArray(key.allowedIps) ? key.allowedIps : [];
    if (allowed.length > 0) {
      const ip = clientIpFrom(req);
      if (!ip || !ipMatchesAllowlist(ip, allowed)) {
        return res.status(403).json({
          error: { code: 'IP_NOT_ALLOWED', message: 'Request IP not in API key allowlist' },
        });
      }
    }
    req.apiKey = key;
    // S122 — stash the scope this route required so the request-log
    // middleware can record it for per-scope rollup.
    req.apiUsedScope = scope;
    next();
  };
}

/**
 * Stage 135 — derive client IP from request. Honours X-Forwarded-For
 * (first entry — closest to client), then falls back to req.ip. Strips
 * "::ffff:" IPv4-mapped-IPv6 prefix so partners can list a plain IPv4
 * entry and have it match regardless of node's mapping.
 */
export function clientIpFrom(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const first = xff.split(',')[0].trim();
  const raw = first || req.ip || '';
  return String(raw).replace(/^::ffff:/, '').trim() || null;
}

/**
 * Stage 135 — true when the given IP matches at least one CIDR entry
 * or exact IP in the allowlist. Supports IPv4 CIDR ("192.168.1.0/24")
 * and bare IP ("203.0.113.5"). IPv6 CIDR deferred — partners with
 * IPv6 egress can list each address explicitly.
 */
export function ipMatchesAllowlist(ip, allowlist) {
  for (const entry of allowlist) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.includes('/')) {
      if (ipv4InCidr(ip, trimmed)) return true;
    } else if (trimmed === ip) {
      return true;
    }
  }
  return false;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;  // unsigned 32-bit
}

function ipv4InCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt == null || ipInt == null) return false;
  if (bits === 0) return true;  // 0.0.0.0/0 matches anything
  const mask = (~((1 << (32 - bits)) - 1)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
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
