// Stage 71 — public crew profile resolver. Renders bio + assigned paket
// list. Returns null when:
//   - no crew row matches the slug
//   - crew is suspended / soft-deleted
//   - both bio AND photoUrl are null (opt-out: a crew without any public
//     content shouldn't have an indexed public page)

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getCrewPublicProfile(slug) {
  if (!slug) return null;
  const profile = await db.crewProfile.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, titlePrefix: true, bio: true, photoUrl: true,
      languages: true, experience: true,
      user: {
        select: { id: true, fullName: true, status: true, deletedAt: true },
      },
    },
  });
  if (!profile || !profile.user) return null;
  if (profile.user.status !== 'ACTIVE' || profile.user.deletedAt) return null;
  // Opt-out: empty profile → no public page
  if (!profile.bio && !profile.photoUrl) return null;

  // Upcoming + recent paket assignments — show 6 ahead, 4 behind
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today.getTime() + 365 * ONE_DAY_MS);
  const pastCutoff = new Date(today.getTime() - 120 * ONE_DAY_MS);

  const assignments = await db.paketCrew.findMany({
    where: {
      userId: profile.user.id,
      paket: {
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        departureDate: { gte: pastCutoff, lt: horizon },
      },
    },
    select: {
      paket: {
        select: {
          slug: true, title: true,
          departureDate: true, durationDays: true,
          status: true,
        },
      },
    },
    orderBy: { paket: { departureDate: 'asc' } },
  });

  const upcoming = [];
  const past = [];
  for (const a of assignments) {
    if (a.paket.departureDate >= today) upcoming.push(a.paket);
    else past.push(a.paket);
  }

  return {
    slug: profile.slug,
    fullName: profile.user.fullName,
    titlePrefix: profile.titlePrefix,
    bio: profile.bio,
    photoUrl: profile.photoUrl,
    languages: profile.languages,
    experience: profile.experience,
    upcomingPaket: upcoming.slice(0, 6),
    pastPaket: past.slice(-4).reverse(), // newest-first
  };
}
