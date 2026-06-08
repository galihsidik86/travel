// Stage 76 — public agent leaderboard. Top N verified + bio'd agents
// ranked by lifetime LUNAS count. Excluded:
//   - non-verified agents (need admin sign-off before showing publicly)
//   - suspended / soft-deleted users
//   - agents with no public profile (bio + photo both null) — they
//     opt-out, so their /a/:slug 404s; listing them on the leaderboard
//     would point to a broken link.
//
// Sorted: lunasCount desc, then displayName for stable order.

import { db } from './../lib/db.js';

export async function getAgentLeaderboardPublic({ limit = 10 } = {}) {
  // Aggregate LUNAS bookings per agentId in one query, then enrich with
  // agent profile data + filter for public-ready agents.
  const bookings = await db.booking.groupBy({
    by: ['agentId'],
    where: {
      status: 'LUNAS',
      agentId: { not: null },
    },
    _count: { _all: true },
  });
  const counts = new Map(bookings.map((b) => [b.agentId, b._count._all]));
  if (counts.size === 0) return [];

  const agentIds = [...counts.keys()];
  const agents = await db.agentProfile.findMany({
    where: {
      id: { in: agentIds },
      isVerified: true,
      OR: [
        { bio: { not: null } },
        { photoUrl: { not: null } },
      ],
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: {
      slug: true, displayName: true,
      photoUrl: true, tier: true, joinedAt: true,
      user: { select: { fullName: true } },
    },
  });

  return agents
    .map((a) => ({
      slug: a.slug,
      displayName: a.displayName,
      fullName: a.user.fullName,
      photoUrl: a.photoUrl,
      tier: a.tier,
      joinedAt: a.joinedAt,
      lunasCount: counts.get(a.id) || 0,
      yearsActive: Math.max(0, Math.floor((Date.now() - new Date(a.joinedAt).getTime()) / (365 * 86_400_000))),
    }))
    .sort((a, b) =>
      b.lunasCount - a.lunasCount
      || a.displayName.localeCompare(b.displayName),
    )
    .slice(0, limit);
}
