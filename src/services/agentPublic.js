// Stage 74 — public agent profile resolver. Mirrors S71 crew flow.
// Returns null when:
//   - agent slug unknown
//   - linked user is suspended / soft-deleted
//   - bio AND photoUrl are both null (opt-out: no public content)
//   - isVerified is false (only verified agents get a public page)

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getAgentPublicProfile(slug) {
  if (!slug) return null;
  const profile = await db.agentProfile.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, displayName: true,
      bio: true, photoUrl: true, igHandle: true, whatsapp: true,
      tier: true, joinedAt: true, isVerified: true,
      user: { select: { id: true, fullName: true, status: true, deletedAt: true } },
    },
  });
  if (!profile || !profile.user) return null;
  if (profile.user.status !== 'ACTIVE' || profile.user.deletedAt) return null;
  if (!profile.isVerified) return null;
  // Opt-out: blank profile → no public page
  if (!profile.bio && !profile.photoUrl) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today.getTime() + 365 * ONE_DAY_MS);

  // What paket has this agent generated bookings for + which are still
  // upcoming? Lifetime LUNAS count is the trust signal.
  const [lunasCount, upcomingPaket] = await Promise.all([
    db.booking.count({
      where: { agentId: profile.id, status: 'LUNAS' },
    }),
    db.paket.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        departureDate: { gte: today, lt: horizon },
        bookings: { some: { agentId: profile.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } } },
      },
      select: {
        slug: true, title: true,
        departureDate: true, durationDays: true,
        kursiTotal: true, kursiTerisi: true,
      },
      orderBy: { departureDate: 'asc' },
      take: 6,
    }),
  ]);

  return {
    slug: profile.slug,
    displayName: profile.displayName,
    fullName: profile.user.fullName,
    bio: profile.bio,
    photoUrl: profile.photoUrl,
    igHandle: profile.igHandle,
    whatsapp: profile.whatsapp,
    tier: profile.tier,
    joinedAt: profile.joinedAt,
    lifetimeLunas: lunasCount,
    upcomingPaket,
  };
}
