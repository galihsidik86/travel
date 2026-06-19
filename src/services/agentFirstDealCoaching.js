// Stage 381 — first-deal coaching widget for new agents.
//
// Returns coaching context when the agent has ZERO LUNAS bookings.
// Surfaces 3 actionable tips on /agen + a count of cold leads needing
// 24h follow-up. Auto-hides (returns null) once first LUNAS lands —
// the new-agent guidance is no longer relevant.
//
// Pure read on existing data; no schema migration.

import { db } from '../lib/db.js';

export async function getAgentFirstDealCoaching({ agentId }) {
  if (!agentId) return null;
  // Single Booking aggregation: do we have any LUNAS yet?
  const lunasCount = await db.booking.count({
    where: { agentId, status: 'LUNAS' },
  });
  if (lunasCount > 0) return null; // experienced agent — no coaching needed

  // Useful stats for the new-agent surface
  const [totalBookings, coldLeadCount, warmLeadCount, agentSlug] = await Promise.all([
    db.booking.count({
      where: { agentId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    }),
    db.lead.count({
      where: { agentId, status: 'COLD', deletedAt: null },
    }),
    db.lead.count({
      where: { agentId, status: 'WARM', deletedAt: null },
    }),
    db.agentProfile.findUnique({
      where: { id: agentId }, select: { slug: true, displayName: true },
    }),
  ]);
  // Cold-leads waiting >24h (potentially overdue follow-up)
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000);
  const staleColdCount = await db.lead.count({
    where: {
      agentId, status: 'COLD', deletedAt: null,
      OR: [
        { updatedAt: { lt: yesterday } },
        // Or follow-up explicitly due (S265)
        { followUpAt: { lte: new Date() } },
      ],
    },
  });

  return {
    isNewAgent: true,
    activeBookingCount: totalBookings,
    coldLeadCount,
    warmLeadCount,
    staleColdCount,
    agentSlug: agentSlug?.slug || null,
    agentDisplayName: agentSlug?.displayName || null,
  };
}
