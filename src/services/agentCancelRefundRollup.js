// Stage 303 — per-agen cancel + refund rate rollup for /admin overview.
//
// For each agent (filtered to those with ≥3 bookings in window — small
// sample percentages are noisy), compute:
//   - cancelRatePct = CANCELLED bookings / total bookings × 100
//   - refundRatePct = REFUNDED bookings / total bookings × 100
//
// Walk-in bookings (agentId null) bucket under `__kp__` sentinel for
// the panel (so admin sees "Kantor Pusat" alongside named agents) —
// same convention as S35 refund analytics + S146 no-show analytics.
//
// Window: trailing N days (default 90). Sort by cancel+refund count
// desc (heaviest leakers surface first). Min-sample guard: agents
// with <3 bookings in window get null rate (not a misleading 0% or
// 33% from a single bad row).

import { db } from '../lib/db.js';

const DEFAULT_DAYS = 90;
const MIN_SAMPLE = 3;
const KP_SENTINEL = '__kp__';

export async function getAgentCancelRefundRollup({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const bookings = await db.booking.findMany({
    where: { createdAt: { gte: cutoff } },
    select: {
      status: true, agentId: true,
      agent: { select: { slug: true, displayName: true } },
    },
  });

  if (bookings.length === 0) {
    return { days, rows: [], totals: { agentCount: 0, totalBookings: 0, totalCancel: 0, totalRefund: 0, overallRatePct: null } };
  }

  const byAgent = new Map();
  for (const b of bookings) {
    const key = b.agentId || KP_SENTINEL;
    if (!byAgent.has(key)) {
      byAgent.set(key, {
        agentSlug: key === KP_SENTINEL ? KP_SENTINEL : (b.agent?.slug || key),
        agentName: b.agent?.displayName || (key === KP_SENTINEL ? 'Kantor Pusat' : '(walk-in)'),
        total: 0, cancel: 0, refund: 0,
      });
    }
    const e = byAgent.get(key);
    e.total += 1;
    if (b.status === 'CANCELLED') e.cancel += 1;
    else if (b.status === 'REFUNDED') e.refund += 1;
  }

  const rows = [...byAgent.values()].map((e) => {
    const ratePct = (n) => Math.round((n / e.total) * 1000) / 10;
    const enough = e.total >= MIN_SAMPLE;
    return {
      ...e,
      cancelRatePct: enough ? ratePct(e.cancel) : null,
      refundRatePct: enough ? ratePct(e.refund) : null,
      lowSample: !enough,
    };
  });
  // Sort by problem-count desc (cancel + refund). Stable secondary by name.
  rows.sort((a, b) => {
    const ad = (a.cancel + a.refund) - (b.cancel + b.refund);
    if (ad !== 0) return -ad;
    return a.agentName.localeCompare(b.agentName);
  });

  const totalBookings = rows.reduce((acc, r) => acc + r.total, 0);
  const totalCancel = rows.reduce((acc, r) => acc + r.cancel, 0);
  const totalRefund = rows.reduce((acc, r) => acc + r.refund, 0);
  const totals = {
    agentCount: rows.length,
    totalBookings,
    totalCancel,
    totalRefund,
    overallRatePct: totalBookings > 0
      ? Math.round(((totalCancel + totalRefund) / totalBookings) * 1000) / 10
      : null,
  };

  return { days, rows, totals };
}

export { KP_SENTINEL, MIN_SAMPLE };
