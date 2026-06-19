// Stage 360 — PWA install funnel KPI.
//
// Tracks the conversion path from "install hint shown" → "install accepted"
// so admin can answer "do our install affordances actually work?" Logged
// into AuditLog (no migration needed — existing append-only table is the
// right shape: ts + actor + entity + action + payload).
//
// Event taxonomy (kept tight to avoid noise):
//   PROMPT_SHOWN          — beforeinstallprompt fired (Android/Desktop)
//   PROMPT_ACCEPTED       — user clicked "Install" in the native prompt
//   PROMPT_DISMISSED      — user clicked "Cancel" in the native prompt
//   IOS_HINT_SHOWN        — our custom iOS hint banner rendered
//   IOS_HINT_DISMISSED    — user tapped × on the iOS hint
//   INSTALLED             — window.appinstalled fired
//
// Pattern: AuditLog entity='PwaInstall', action=<EVENT>, actor=user if
// logged in else null. payload carries { userAgent, role, kind } for
// cohort slicing later.

import { db } from '../lib/db.js';

const KNOWN_EVENTS = new Set([
  'PROMPT_SHOWN', 'PROMPT_ACCEPTED', 'PROMPT_DISMISSED',
  'IOS_HINT_SHOWN', 'IOS_HINT_DISMISSED',
  'INSTALLED',
]);

export function isKnownInstallEvent(name) {
  return KNOWN_EVENTS.has(name);
}

/**
 * Record a single install funnel event. Best-effort — write failures log
 * but don't throw (the client doesn't care; this is fire-and-forget telemetry).
 * Actor is optional — many install events fire BEFORE login (public paket
 * landing), so the funnel must handle anonymous events cleanly.
 */
// AuditLog.action is the AuditAction enum — can't carry our event names.
// We use action='CREATE' (we're creating a telemetry row) + entityId=<event>
// so the groupBy in `getPwaInstallFunnel` can still bucket by event kind
// without a schema migration. The role/kind/userAgent live in `after`.
export async function recordInstallEvent({ event, userAgent, role, kind, actorId, actorEmail }) {
  if (!isKnownInstallEvent(event)) return { ok: false, reason: 'unknown_event' };
  try {
    await db.auditLog.create({
      data: {
        actorUserId: actorId || null,
        actorEmail: actorEmail || 'anonymous',
        actorRole: role || null,
        action: 'CREATE',
        entity: 'PwaInstall',
        entityId: event, // bucketed by event kind — no per-row id needed
        before: null,
        after: {
          event, // duplicated here so the after payload is self-describing
          userAgent: (userAgent || '').slice(0, 500),
          role: role || null,
          kind: kind || null, // 'jemaah' / 'crew' / 'admin' / 'public'
        },
      },
    });
    return { ok: true };
  } catch (err) {
    console.warn('[pwaInstallFunnel] log failed:', err?.message || err);
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * Aggregate install funnel events over a window. Returns per-event counts
 * + conversion percentages for the two flow paths:
 *   - Android/Desktop:  PROMPT_SHOWN → PROMPT_ACCEPTED  (acceptanceRate)
 *   - iOS:              IOS_HINT_SHOWN → INSTALLED       (iosCompletionRate)
 *
 * The iOS completion rate is approximate — we can't observe the actual
 * Add-to-Home-Screen tap on Safari, so we proxy via window.appinstalled
 * (which fires post-install in some Safari versions). When the rate looks
 * suspiciously low, treat it as a "best signal we have" not "definitely
 * accurate".
 */
export async function getPwaInstallFunnel({ days = 30 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000);
  const rows = await db.auditLog.groupBy({
    by: ['entityId'],
    where: {
      entity: 'PwaInstall',
      createdAt: { gte: since },
    },
    _count: { entityId: true },
  });
  const counts = {};
  for (const e of KNOWN_EVENTS) counts[e] = 0;
  for (const r of rows) {
    if (counts[r.entityId] !== undefined) counts[r.entityId] = r._count.entityId;
  }
  // Acceptance rate: of users that SAW the native prompt, how many accepted?
  // Returns null when denominator is 0 (avoids divide-by-zero / misleading 0%).
  const promptDenom = counts.PROMPT_SHOWN;
  const acceptanceRate = promptDenom > 0
    ? Math.round((counts.PROMPT_ACCEPTED / promptDenom) * 1000) / 10
    : null;
  // iOS completion proxy: dismissed-vs-installed split among hint-shown users.
  const iosDenom = counts.IOS_HINT_SHOWN;
  // Only INSTALLED events that aren't preceded by a native prompt accept
  // count as iOS-side completions. We approximate by attributing
  // (INSTALLED - PROMPT_ACCEPTED) to iOS — imperfect but directionally
  // useful. When negative (more accepts than installs, possible in dev),
  // clamp to 0.
  const iosInstalled = Math.max(0, counts.INSTALLED - counts.PROMPT_ACCEPTED);
  const iosCompletionRate = iosDenom > 0
    ? Math.round((iosInstalled / iosDenom) * 1000) / 10
    : null;
  // Sample-size flag — under 5 events on either denominator is too noisy.
  const lowSample = promptDenom < 5 && iosDenom < 5;
  return {
    days,
    counts,
    acceptanceRate,
    iosCompletionRate,
    iosInstalled,
    lowSample,
  };
}

export { KNOWN_EVENTS };
