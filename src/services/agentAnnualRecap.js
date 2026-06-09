// Stage 158 — yearly Jan 5 recap of an agent's komisi statements for
// the previous calendar year. Aggregates all 12 KomisiStatement rows
// (whatever subset exist) into a single email with totals + per-month
// breakdown + download links. Silent on agents with zero activity.

import { db } from '../lib/db.js';

/**
 * Previous calendar year (number). Cron Jan 5 — `now=2026-01-05` →
 * returns 2025. Used as the recap window.
 */
export function previousYear(now = new Date()) {
  return now.getFullYear() - 1;
}

/**
 * Stage 158 — build the recap payload for one agent + year.
 *
 * Returns `{agentId, year, statements, totals}` where:
 *   - `statements`: rows from KomisiStatement matching periodYM like `<year>-%`
 *     sorted ascending (Jan → Dec).
 *   - `totals`: aggregate `{earnedIdr, paidIdr, lineCount, statementCount}`
 *     across the statements in scope.
 *
 * Returns null when the agent has zero statements for the year — caller
 * silently skips (no email worth sending).
 */
export async function buildAgentAnnualRecap({ agentId, year }) {
  const prefix = `${year}-`;
  const statements = await db.komisiStatement.findMany({
    where: { agentId, periodYM: { startsWith: prefix } },
    orderBy: { periodYM: 'asc' },
    select: {
      id: true, periodYM: true,
      totalEarnedIdr: true, totalPaidIdr: true, lineCount: true,
    },
  });
  if (statements.length === 0) return null;
  let totalEarnedIdr = 0, totalPaidIdr = 0, totalLineCount = 0;
  for (const s of statements) {
    totalEarnedIdr += Number(s.totalEarnedIdr.toString());
    totalPaidIdr += Number(s.totalPaidIdr.toString());
    totalLineCount += s.lineCount;
  }
  return {
    agentId, year,
    statements,
    totals: {
      earnedIdr: totalEarnedIdr,
      paidIdr: totalPaidIdr,
      lineCount: totalLineCount,
      statementCount: statements.length,
    },
  };
}

/**
 * Stage 158 — batch entry-point used by the Jan 5 cron + HTTP trigger.
 * Iterates every ACTIVE agent that has ≥1 statement in `year`, builds
 * the recap, fires the notif. Per-agent failures are caught + logged
 * so a bad row doesn't abort the batch.
 *
 * Idempotency: NONE. The expected cadence is once-per-year so an
 * accidental double-run sends duplicate emails. Operators who need to
 * re-run for a subset can pass a specific year via the HTTP trigger.
 */
export async function sendAgentAnnualRecaps({ year = previousYear(), now = new Date() } = {}) {
  const agents = await listAgentsWithStatementsForYear({ year });
  let enqueued = 0, skipped = 0, errors = 0;
  for (const a of agents) {
    try {
      const recap = await buildAgentAnnualRecap({ agentId: a.id, year });
      if (!recap) { skipped += 1; continue; }
      const { notifyAgentAnnualRecap } = await import('./notifications.js');
      const r = await notifyAgentAnnualRecap({
        recap,
        agent: {
          id: a.id, slug: a.slug, displayName: a.displayName,
          email: a.user?.email, userId: a.userId,
          notifKomisiStatement: a.notifKomisiStatement,
        },
      });
      if (r.enqueued) enqueued += r.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[agent-recap] agent ${a.slug} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { agentCount: agents.length, enqueued, skipped, errors, year };
}

/**
 * Stage 158 — list ACTIVE agents with at least one statement in the
 * given year. Used by the cron loop so we skip agents with no data.
 */
export async function listAgentsWithStatementsForYear({ year }) {
  const prefix = `${year}-`;
  // Distinct agentId from KomisiStatement rows in window, filtered to
  // ACTIVE agents only (suspended/deleted agents don't get retro emails).
  const rows = await db.komisiStatement.findMany({
    where: {
      periodYM: { startsWith: prefix },
      agent: { user: { status: 'ACTIVE', deletedAt: null } },
    },
    select: {
      agent: {
        select: {
          id: true, slug: true, displayName: true, userId: true,
          notifKomisiStatement: true,
          user: { select: { email: true } },
        },
      },
    },
    distinct: ['agentId'],
  });
  return rows.map((r) => r.agent).filter((a) => !!a);
}
