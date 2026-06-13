// Stage 267 — agent CRM "Hari ini" widget. Returns the agent's leads
// that need attention today: overdue follow-ups + due-today follow-ups.
//
// Distinct from S46 stalled-leads daily digest (that's an email at 08:00
// listing COLD/WARM leads with `updatedAt > 7 days ago`). This is the
// inline UI surface: the agent opens `/agen` and sees right at the top
// "you scheduled 3 calls for today + 2 from yesterday haven't moved".
//
// Sort: oldest overdue first so the most-neglected lead surfaces at the
// top. Snoozed leads (S266) excluded — agent explicitly said "not today".
// CONVERTED/LOST excluded (terminal — no follow-up needed).
import { db } from '../lib/db.js';

/**
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {Date} [opts.now] for tests
 * @returns {Promise<{overdue: Array, today: Array, total: number}>}
 */
export async function getAgentTodayLeads({ agentId, now = new Date() } = {}) {
  if (!agentId) return { overdue: [], today: [], total: 0 };

  // Compute end-of-today (local) so a follow-up scheduled at 23:59 today
  // still counts as "today", not overdue.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const leads = await db.lead.findMany({
    where: {
      agentId,
      deletedAt: null,
      status: { in: ['COLD', 'WARM'] },
      followUpAt: { not: null, lt: startOfTomorrow },
      OR: [
        { snoozedUntilAt: null },
        { snoozedUntilAt: { lte: now } },
      ],
    },
    orderBy: { followUpAt: 'asc' },
    select: {
      id: true, fullName: true, phone: true, status: true, source: true,
      followUpAt: true, notes: true, score: true,
      interestedPaketSlug: true, interestedKelas: true, estPaxCount: true,
    },
  });

  const overdue = [];
  const today = [];
  for (const l of leads) {
    if (l.followUpAt < startOfToday) overdue.push(l);
    else today.push(l);
  }

  return { overdue, today, total: overdue.length + today.length };
}
