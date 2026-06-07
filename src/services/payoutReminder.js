// Stage 37 — smart payout reminder. Closes the loop on the agent weekly
// digest (S36): agents see their earned komisi pile up; this email tells
// the admins WHICH agents have crossed a threshold and are overdue for
// a payout.
//
// "Overdue" = sum of EARNED komisi rows ≥ threshold (default Rp 1M).
// Once an admin runs the payout, the rows flip to PAID and naturally
// drop off the list — no separate state to track.
//
// Sources are the same the /admin/payouts page reads, so the reminder
// and the workspace can't disagree.

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const DEFAULT_THRESHOLD_IDR = 1_000_000;

const fmtRp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

/**
 * List agents whose total EARNED komisi (not yet paid out) crosses the
 * threshold. Includes the per-agent count + oldest earnedAt so the email
 * can show "this komisi has been waiting X days".
 *
 * Returns at most `limit` agents, sorted by total descending (largest
 * owed first — most likely to upset the agent if delayed).
 */
export async function getOverduePayoutCandidates({
  thresholdIdr = DEFAULT_THRESHOLD_IDR,
  limit = 20,
  now = new Date(),
} = {}) {
  const earned = await db.komisi.findMany({
    // EARNED komisi only — no agentId-NULL filter; the JS loop already
    // skips rows where agentId is missing. (Prisma v6 doesn't accept
    // `{ not: null }` or `{ isNot: null }` for this shape.)
    where: { status: 'EARNED' },
    select: {
      agentId: true, amount: true, earnedAt: true,
      agent: { select: { slug: true, displayName: true } },
    },
  });

  const byAgent = new Map();
  for (const k of earned) {
    if (!k.agentId) continue;
    const row = byAgent.get(k.agentId) || {
      agentId: k.agentId,
      agent: k.agent,
      totalIdr: 0,
      count: 0,
      oldestEarnedAt: null,
    };
    row.totalIdr += toNumber(k.amount) ?? 0;
    row.count += 1;
    if (!row.oldestEarnedAt || (k.earnedAt && k.earnedAt < row.oldestEarnedAt)) {
      row.oldestEarnedAt = k.earnedAt;
    }
    byAgent.set(k.agentId, row);
  }

  const ageDays = (d) => Math.floor((now.getTime() - d.getTime()) / 86_400_000);

  const rows = [...byAgent.values()]
    .filter((r) => r.totalIdr >= thresholdIdr)
    .map((r) => ({
      ...r,
      ageDays: r.oldestEarnedAt ? ageDays(r.oldestEarnedAt) : null,
      totalFormatted: fmtRp(r.totalIdr),
    }))
    .sort((a, b) => b.totalIdr - a.totalIdr)
    .slice(0, limit);

  const grandTotalIdr = rows.reduce((a, r) => a + r.totalIdr, 0);

  return {
    rows,
    counts: {
      candidates: rows.length,
      thresholdIdr,
      grandTotalIdr,
    },
  };
}
