// Stage 124 — find API keys with granted-but-unused scopes over a
// rolling window. Surfaces what S122's panel made visible into a
// weekly digest so admin doesn't have to remember to check.
//
// "Unused" means: the key had ≥1 request in the window (it's an
// active key, not abandoned) AND ≥1 granted scope produced zero
// ApiRequestLog rows. Keys with zero traffic at all are skipped
// (different problem — probably abandoned, surface via lastUsedAt
// elsewhere).
//
// Silent on healthy weeks (no candidates → empty rows array, the
// notify helper skips fan-out).

import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getApiKeyScopeDownCandidates({ days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * ONE_DAY_MS);

  // Pull ACTIVE keys with their scope list
  const keys = await db.apiKey.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, scopes: true, createdAt: true, lastUsedAt: true },
  });
  if (keys.length === 0) return { rows: [], windowDays: days };

  // Pull usage counts in one shot
  const usage = await db.apiRequestLog.groupBy({
    by: ['apiKeyId', 'scope'],
    where: { ts: { gte: since }, apiKeyId: { in: keys.map((k) => k.id) } },
    _count: { _all: true },
  });

  // Index per key
  const byKey = new Map();
  for (const u of usage) {
    if (!byKey.has(u.apiKeyId)) byKey.set(u.apiKeyId, { total: 0, scopes: new Set() });
    const slot = byKey.get(u.apiKeyId);
    slot.total += u._count._all;
    if (u.scope) slot.scopes.add(u.scope);
  }

  const rows = [];
  for (const k of keys) {
    const slot = byKey.get(k.id) || { total: 0, scopes: new Set() };
    if (slot.total === 0) continue;  // zero traffic — separate problem
    const granted = Array.isArray(k.scopes) ? k.scopes : [];
    const unused = granted.filter((s) => !slot.scopes.has(s));
    if (unused.length === 0) continue;
    rows.push({
      apiKeyId: k.id,
      name: k.name,
      requestCount: slot.total,
      granted, unused,
      // Used = granted minus unused. Helps the digest body read naturally.
      used: granted.filter((s) => slot.scopes.has(s)),
    });
  }
  // Most unused-scopes first — biggest scope-down wins surface
  rows.sort((a, z) => z.unused.length - a.unused.length);

  return { rows, windowDays: days };
}
