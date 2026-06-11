// Stage 185 — flag ACTIVE agents with no booking + no lead activity
// in the last `inactiveDays` (default 60). Daily cron stamps
// `AgentProfile.dormantSince` when the agent crosses the threshold;
// auto-clears (back to null) on the next run when fresh activity
// is detected.
//
// "Activity" = any of:
//   - Booking created via the agent in the window
//   - Lead created/updated via the agent in the window
//
// Walk-in / Kantor-Pusat agents (no agent FK) aren't considered —
// the dormancy signal is about the salesperson's personal pipeline.
//
// Suspended/soft-deleted agents are excluded from the scan — they're
// already inactive by definition.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

const DEFAULT_INACTIVE_DAYS = 60;

export async function scanAgentDormancy({
  now = new Date(),
  inactiveDays = DEFAULT_INACTIVE_DAYS,
  req = null, actor = null,
} = {}) {
  const cutoff = new Date(now.getTime() - inactiveDays * 24 * 60 * 60_000);

  // Pull every ACTIVE agent — small N, cheap. We compute activity in JS
  // per row via two cheap COUNT-style queries each so a 50-agent fleet
  // is a 100-query scan (fast enough for daily cron).
  const agents = await db.agentProfile.findMany({
    where: {
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: { id: true, slug: true, displayName: true, dormantSince: true },
  });

  let flaggedNew = 0;
  let cleared = 0;
  let stayedDormant = 0;
  let stayedActive = 0;
  const transitions = [];

  for (const a of agents) {
    // Active = at least one booking OR lead with recent activity
    const [bookingCount, leadCount] = await Promise.all([
      db.booking.count({
        where: {
          agentId: a.id,
          createdAt: { gte: cutoff },
        },
      }),
      db.lead.count({
        where: {
          agentId: a.id,
          // Recent CREATE or UPDATE counts (`updatedAt` covers both since
          // Prisma stamps it on insert too)
          updatedAt: { gte: cutoff },
          deletedAt: null,
        },
      }),
    ]);
    const isActive = bookingCount > 0 || leadCount > 0;

    if (!isActive && a.dormantSince == null) {
      // Cross the threshold → stamp dormantSince
      await db.agentProfile.update({
        where: { id: a.id }, data: { dormantSince: now },
      });
      await audit({
        req, actor: actor || { email: 'system', role: null },
        action: 'UPDATE', entity: 'AgentProfile', entityId: a.id,
        before: { dormantSince: null },
        after: {
          dormantSince: now.toISOString(),
          dormancyScan: true, inactiveDays,
          recentBookings: bookingCount, recentLeads: leadCount,
        },
      });
      flaggedNew += 1;
      transitions.push({ slug: a.slug, displayName: a.displayName, transition: 'flagged' });
    } else if (isActive && a.dormantSince != null) {
      // Fresh activity → clear the stamp
      await db.agentProfile.update({
        where: { id: a.id }, data: { dormantSince: null },
      });
      await audit({
        req, actor: actor || { email: 'system', role: null },
        action: 'UPDATE', entity: 'AgentProfile', entityId: a.id,
        before: { dormantSince: a.dormantSince?.toISOString?.() ?? a.dormantSince },
        after: { dormantSince: null, dormancyScan: true, resumedActivity: true },
      });
      cleared += 1;
      transitions.push({ slug: a.slug, displayName: a.displayName, transition: 'cleared' });
    } else if (!isActive) {
      stayedDormant += 1;
    } else {
      stayedActive += 1;
    }
  }

  return {
    inactiveDays, scanned: agents.length,
    flaggedNew, cleared, stayedDormant, stayedActive,
    transitions,
  };
}

export { DEFAULT_INACTIVE_DAYS };
