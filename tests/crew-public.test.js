// Stage 71 — crew public profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif, tempPaket } from './_helpers.js';
import { getCrewPublicProfile } from '../src/services/crewPublic.js';

test('returns null when slug is missing', async () => {
  assert.equal(await getCrewPublicProfile(null), null);
  assert.equal(await getCrewPublicProfile(''), null);
});

test('returns null when slug unknown', async () => {
  assert.equal(await getCrewPublicProfile('zzz-not-here-xyz'), null);
});

test('returns null when crew has no bio AND no photoUrl (opt-out)', async (t) => {
  const tag = makeTag('cp-empty');
  const m = await tempMuthawwif(t, tag);
  const slug = `${tag}-slug`;
  await db.crewProfile.create({
    data: { userId: m.id, slug },
  });
  const r = await getCrewPublicProfile(slug);
  assert.equal(r, null);
  await db.crewProfile.deleteMany({ where: { userId: m.id } });
});

test('returns null when crew is suspended', async (t) => {
  const tag = makeTag('cp-sus');
  const m = await tempMuthawwif(t, tag, { status: 'SUSPENDED' });
  const slug = `${tag}-slug`;
  await db.crewProfile.create({
    data: { userId: m.id, slug, bio: 'bio body here' },
  });
  const r = await getCrewPublicProfile(slug);
  assert.equal(r, null);
  await db.crewProfile.deleteMany({ where: { userId: m.id } });
});

test('returns profile + upcoming + past paket', async (t) => {
  const tag = makeTag('cp-full');
  const m = await tempMuthawwif(t, tag);
  const slug = `${tag}-slug`;
  await db.crewProfile.create({
    data: {
      userId: m.id, slug,
      titlePrefix: 'Ustadz',
      bio: 'Pengalaman 10 tahun mendampingi jemaah umrah dan haji.',
      photoUrl: '/uploads/crew/test.jpg',
      languages: 'Indonesia, Arab',
      experience: 10,
    },
  });
  // Upcoming paket
  const upcoming = await tempPaket(t, `${tag}-up`);
  await db.paket.update({
    where: { id: upcoming.id },
    data: { departureDate: new Date(Date.now() + 30 * 86_400_000) },
  });
  await db.paketCrew.create({ data: { paketId: upcoming.id, userId: m.id } });
  // Past paket — 60 days ago
  const past = await tempPaket(t, `${tag}-past`);
  await db.paket.update({
    where: { id: past.id },
    data: { departureDate: new Date(Date.now() - 60 * 86_400_000) },
  });
  await db.paketCrew.create({ data: { paketId: past.id, userId: m.id } });

  const r = await getCrewPublicProfile(slug);
  assert.ok(r);
  assert.equal(r.titlePrefix, 'Ustadz');
  assert.equal(r.experience, 10);
  const upSlugs = r.upcomingPaket.map((p) => p.slug);
  const pastSlugs = r.pastPaket.map((p) => p.slug);
  assert.ok(upSlugs.includes(upcoming.slug), 'upcoming paket must appear');
  assert.ok(pastSlugs.includes(past.slug), 'past paket must appear');

  await db.crewProfile.deleteMany({ where: { userId: m.id } });
});
