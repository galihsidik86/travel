// Stage 163 — soft daily nudge to agents who haven't opened recent
// komisi statements. WA-only (concise, not email noise). Per-agent
// cooldown via the existing Notification table — we skip an agent
// if they've gotten a STATEMENT_UNREAD_NUDGE in the last N days
// (default 14, so monthly statements get at most two nudges).
//
// Silent on agents with zero unread or those who opted out of
// statement notifs (S157). Same opt-out toggle since this IS a
// statement-related nudge — admins don't get a separate flag for
// "I want statement emails but not WA nudges".

import { db } from '../lib/db.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_DAYS = 14;
const DEFAULT_WINDOW_MONTHS = 3;

/**
 * Find agents who:
 *   - are ACTIVE + have not opted out of statement notifs
 *   - have ≥1 KomisiStatement in last `windowMonths` with
 *     agentDownloadCount = 0
 *   - have NOT been nudged within `cooldownDays`
 *
 * Returns `{rows, windowMonths, cooldownDays}` where each row is:
 *   `{agent, unreadCount, oldestUnreadPeriod}`.
 */
export async function getUnreadStatementCandidates({
  now = new Date(),
  windowMonths = DEFAULT_WINDOW_MONTHS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const windowStart = new Date(now.getTime() - windowMonths * MONTH_MS);
  const cooldownCutoff = new Date(now.getTime() - cooldownDays * 24 * 60 * 60 * 1000);

  // Pull all unread statements in window, joined with the agent. We
  // group in JS — the candidate set is bounded by active agents, so
  // a per-agent groupBy is cheaper than a more elaborate SQL query.
  const unread = await db.komisiStatement.findMany({
    where: {
      agentDownloadCount: 0,
      generatedAt: { gte: windowStart },
      agent: {
        notifKomisiStatement: true,
        user: { status: 'ACTIVE', deletedAt: null },
      },
    },
    orderBy: { periodYM: 'asc' },
    select: {
      id: true, periodYM: true, lineCount: true,
      agentId: true,
      agent: {
        select: {
          id: true, slug: true, displayName: true, whatsapp: true,
          userId: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  // Group by agent. Skip zero-line statements (no content to nudge about).
  const perAgent = new Map();
  for (const s of unread) {
    if (s.lineCount === 0) continue;
    if (!s.agent) continue;
    let row = perAgent.get(s.agentId);
    if (!row) {
      row = {
        agent: s.agent,
        unreadCount: 0,
        oldestUnreadPeriod: s.periodYM,
        unreadIds: [],
      };
      perAgent.set(s.agentId, row);
    }
    row.unreadCount += 1;
    row.unreadIds.push(s.id);
    // periodYM ordering is alphabetical = chronological for YYYY-MM
    if (s.periodYM < row.oldestUnreadPeriod) row.oldestUnreadPeriod = s.periodYM;
  }

  // Apply cooldown — exclude agents who got a STATEMENT_UNREAD_NUDGE
  // within `cooldownDays`. Cheap to filter post-aggregation since the
  // agent count is bounded; a single query against the notif table
  // gets all recent recipients.
  const agentIds = [...perAgent.keys()];
  if (agentIds.length === 0) {
    return { rows: [], windowMonths, cooldownDays };
  }
  // We track by recipientUserId (the agent's user) since `agentId` isn't
  // a notif column. Skip agents who got a STATEMENT_UNREAD_NUDGE within
  // cooldown.
  const userIds = [...perAgent.values()]
    .map((r) => r.agent.userId)
    .filter(Boolean);
  const recentNudges = userIds.length === 0 ? [] : await db.notification.findMany({
    where: {
      type: 'STATEMENT_UNREAD_NUDGE',
      recipientUserId: { in: userIds },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientUserId: true },
  });
  const recentlyNudged = new Set(recentNudges.map((n) => n.recipientUserId));

  const rows = [];
  for (const r of perAgent.values()) {
    if (recentlyNudged.has(r.agent.userId)) continue;
    rows.push(r);
  }
  // Sort by oldest-unread first so most-stale agents get nudged first
  // if a per-run quota is ever added.
  rows.sort((a, b) => a.oldestUnreadPeriod.localeCompare(b.oldestUnreadPeriod));
  return { rows, windowMonths, cooldownDays };
}

/**
 * Batch entry — pulls candidates + fires the nudge. Silent on empty
 * candidate list.
 */
export async function sendStatementUnreadNudges({
  now = new Date(),
  windowMonths = DEFAULT_WINDOW_MONTHS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const candidates = await getUnreadStatementCandidates({ now, windowMonths, cooldownDays });
  if (candidates.rows.length === 0) {
    return { agentCount: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  const { notifyStatementUnreadNudge } = await import('./notifications.js');
  let enqueued = 0, skipped = 0, errors = 0;
  for (const c of candidates.rows) {
    try {
      const r = await notifyStatementUnreadNudge({
        agent: c.agent,
        unreadCount: c.unreadCount,
        oldestPeriod: c.oldestUnreadPeriod,
      });
      if (r.enqueued) enqueued += r.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[statement-nudge] agent ${c.agent.slug} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { agentCount: candidates.rows.length, enqueued, skipped, errors };
}

export { DEFAULT_COOLDOWN_DAYS, DEFAULT_WINDOW_MONTHS };
