// Stage 255 — admin recently-viewed trail. Tracks the last 15 entities
// admin opened (booking, jemaah, paket, agen) on User.recentEntities.
// Surfaced on /admin overview as quick-jump cards.
//
// Pure best-effort:
//   - track failure logs but never aborts the calling request
//   - validation is permissive — kind/id/label cleaned + capped
//   - same-entity re-view shifts the existing entry to the top (dedup
//     by (kind, id)) rather than producing two adjacent entries
//
// Storage format on User.recentEntities (JSON array):
//   [{ kind, id, label, viewedAt }]
// where `kind` ∈ {booking, jemaah, paket, agen}.

import { db } from '../lib/db.js';

const MAX_RECENT = 15;
const VALID_KINDS = new Set(['booking', 'jemaah', 'paket', 'agen']);

function clean(s, max = 200) {
  if (s == null) return '';
  return String(s).trim().slice(0, max);
}

export async function trackRecentEntity({ userId, kind, id, label }) {
  if (!userId || !VALID_KINDS.has(kind) || !id) return;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { recentEntities: true },
    });
    if (!user) return;
    const list = Array.isArray(user.recentEntities) ? [...user.recentEntities] : [];
    // Dedup by (kind, id) — keep the freshest view
    const filtered = list.filter((e) => !(e?.kind === kind && e?.id === id));
    filtered.unshift({
      kind,
      id: clean(id, 40),
      label: clean(label || id, 120),
      viewedAt: new Date().toISOString(),
    });
    const bounded = filtered.slice(0, MAX_RECENT);
    await db.user.update({
      where: { id: userId },
      data: { recentEntities: bounded },
    });
  } catch (err) {
    console.warn('[trackRecentEntity] failed:', err?.message || err);
  }
}

/**
 * Returns the list as stored (newest first). Empty array when never
 * tracked.
 */
export async function getRecentEntities({ userId }) {
  if (!userId) return [];
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { recentEntities: true },
  });
  if (!user) return [];
  return Array.isArray(user.recentEntities) ? user.recentEntities : [];
}

export { MAX_RECENT, VALID_KINDS };
