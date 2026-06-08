// Stage 121/122 — partner API analytics over a rolling window.
//
// Per-key rollup answers:
//   - how many requests in last N days?
//   - what % failed (5xx)?
//   - what's the p95 duration? (slow integrations are a partner-side
//     bug we can prove with this)
//   - which scopes did they actually use? (compliance audit — partner
//     asked for read:audit but only ever called read:bookings → can
//     scope down)
//
// All in JS after a single bounded query. Per-key request volume on a
// healthy install is sub-100k/day; loading and grouping is fine.

import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return Math.round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

/**
 * Per-key 7-day rollup. Returns one entry per ApiKey row that has at
 * least one logged request in the window — keys with zero traffic are
 * omitted (the admin viewer already shows lastUsedAt for those).
 */
export async function getApiKeyAnalytics({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * ONE_DAY_MS);
  const rows = await db.apiRequestLog.findMany({
    where: { ts: { gte: since }, apiKeyId: { not: null } },
    select: {
      apiKeyId: true, path: true, statusCode: true, durationMs: true, scope: true,
    },
  });
  if (rows.length === 0) return { rows: [], windowDays: days, totals: { requests: 0, errors5xx: 0, keys: 0 } };

  // Index rows by apiKeyId
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.apiKeyId)) {
      byKey.set(r.apiKeyId, {
        requests: 0, errors5xx: 0, errors4xx: 0,
        durations: [],
        paths: new Map(),
        scopes: new Map(),
      });
    }
    const slot = byKey.get(r.apiKeyId);
    slot.requests += 1;
    if (r.statusCode >= 500) slot.errors5xx += 1;
    else if (r.statusCode >= 400) slot.errors4xx += 1;
    slot.durations.push(r.durationMs);
    slot.paths.set(r.path, (slot.paths.get(r.path) || 0) + 1);
    if (r.scope) slot.scopes.set(r.scope, (slot.scopes.get(r.scope) || 0) + 1);
  }

  // Look up key names + scopes config so admin sees who's hammering
  const keys = await db.apiKey.findMany({
    where: { id: { in: [...byKey.keys()] } },
    select: { id: true, name: true, status: true, scopes: true, rateLimitPerMin: true },
  });
  const keyMeta = new Map(keys.map((k) => [k.id, k]));

  const out = [];
  for (const [keyId, slot] of byKey) {
    const sorted = slot.durations.slice().sort((a, z) => a - z);
    const topPaths = [...slot.paths.entries()]
      .sort((a, z) => z[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => ({ path, count }));
    const scopeUsage = [...slot.scopes.entries()]
      .sort((a, z) => z[1] - a[1])
      .map(([scope, count]) => ({ scope, count }));
    const meta = keyMeta.get(keyId);
    const grantedScopes = Array.isArray(meta?.scopes) ? meta.scopes : [];
    const usedScopeNames = new Set(scopeUsage.map((s) => s.scope));
    const unusedScopes = grantedScopes.filter((s) => !usedScopeNames.has(s));

    out.push({
      apiKeyId: keyId,
      name: meta?.name || '(deleted key)',
      status: meta?.status || null,
      rateLimitPerMin: meta?.rateLimitPerMin ?? null,
      requests: slot.requests,
      errors5xx: slot.errors5xx,
      errors4xx: slot.errors4xx,
      errorRate5xxPct: slot.requests > 0 ? Math.round((slot.errors5xx / slot.requests) * 1000) / 10 : 0,
      p50DurationMs: percentile(sorted, 50),
      p95DurationMs: percentile(sorted, 95),
      topPaths,
      scopeUsage,                // [{scope, count}, ...] — what they actually used
      grantedScopes,             // what they have permission for
      unusedScopes,              // granted but unused — candidate for scope-down
    });
  }
  // Sort by request volume desc — busiest partners on top
  out.sort((a, z) => z.requests - a.requests);

  return {
    rows: out,
    windowDays: days,
    totals: {
      requests: rows.length,
      errors5xx: rows.filter((r) => r.statusCode >= 500).length,
      keys: out.length,
    },
  };
}
