// Stage 213 — crew dietary brief email for near-departure paket.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempMuthawwif } from './_helpers.js';
import {
  getCrewDietaryBriefCandidates,
  formatDietaryBrief,
  notifyCrewDietaryBrief,
} from '../src/services/crewDietaryBrief.js';

async function setDiet(jemaahId, dietary, dietaryNotes = null) {
  await db.jemaahProfile.update({ where: { id: jemaahId }, data: { dietary, dietaryNotes } });
}

async function assignCrew(paket, user) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: user.id } });
}

test('getCrewDietaryBriefCandidates: empty when no near-departure paket', async (t) => {
  const tag = makeTag('s213-empty');
  const crew = await tempMuthawwif(t, tag);
  // Paket 60 days out — outside default 14d window
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: new Date(Date.now() + 60 * 86_400_000),
      returnDate: new Date(Date.now() + 70 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  await assignCrew(paket, crew);
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const r = await getCrewDietaryBriefCandidates({ now: new Date(), windowDays: 14 });
  const mine = r.filter((c) => c.user.id === crew.id);
  assert.equal(mine.length, 0);
});

test('getCrewDietaryBriefCandidates: surfaces crew with near-departure paket', async (t) => {
  const tag = makeTag('s213-near');
  const crew = await tempMuthawwif(t, tag);
  // Paket 7 days out — inside default 14d window
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: new Date(Date.now() + 7 * 86_400_000),
      returnDate: new Date(Date.now() + 17 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  await assignCrew(paket, crew);
  const jem = await tempJemaah(t, tag);
  await setDiet(jem.jemaah.id, 'VEGETARIAN');
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'PENDING',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const candidates = await getCrewDietaryBriefCandidates({ now: new Date(), windowDays: 14 });
  const mine = candidates.find((c) => c.user.id === crew.id);
  assert.ok(mine, 'crew surfaces');
  assert.equal(mine.specials.length, 1);
  assert.equal(mine.specials[0].jemaah.dietary, 'VEGETARIAN');
  assert.equal(mine.tally.VEGETARIAN, 1);
  assert.equal(mine.totalPax, 1);
  assert.equal(mine.specialPax, 1);
});

test('getCrewDietaryBriefCandidates: ARCHIVED + soft-deleted paket excluded', async (t) => {
  const tag = makeTag('s213-archived');
  const crew = await tempMuthawwif(t, tag);
  const archived = await db.paket.create({
    data: {
      slug: tag + '-a', title: `Archived ${tag}`,
      departureDate: new Date(Date.now() + 7 * 86_400_000),
      returnDate: new Date(Date.now() + 17 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ARCHIVED',
    },
  });
  await assignCrew(archived, crew);
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { paketId: archived.id } });
    await db.paket.deleteMany({ where: { id: archived.id } });
  });

  const candidates = await getCrewDietaryBriefCandidates({ now: new Date(), windowDays: 14 });
  const mine = candidates.find((c) => c.user.id === crew.id);
  assert.equal(mine, undefined);
});

test('getCrewDietaryBriefCandidates: CANCELLED bookings not in specials', async (t) => {
  const tag = makeTag('s213-cancel');
  const crew = await tempMuthawwif(t, tag);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: new Date(Date.now() + 7 * 86_400_000),
      returnDate: new Date(Date.now() + 17 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  await assignCrew(paket, crew);
  const jem = await tempJemaah(t, tag);
  await setDiet(jem.jemaah.id, 'DIABETIC');
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-cancel`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const candidates = await getCrewDietaryBriefCandidates({ now: new Date(), windowDays: 14 });
  const mine = candidates.find((c) => c.user.id === crew.id);
  // Crew assigned but their paket has zero non-cancelled jemaah → specials empty
  assert.equal(mine.specials.length, 0);
  assert.equal(mine.specialPax, 0);
});

test('getCrewDietaryBriefCandidates: SUSPENDED crew excluded', async (t) => {
  const tag = makeTag('s213-suspend');
  const crew = await tempMuthawwif(t, tag, { status: 'SUSPENDED' });
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: new Date(Date.now() + 7 * 86_400_000),
      returnDate: new Date(Date.now() + 17 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  await assignCrew(paket, crew);
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });

  const candidates = await getCrewDietaryBriefCandidates({ now: new Date(), windowDays: 14 });
  const mine = candidates.find((c) => c.user.id === crew.id);
  assert.equal(mine, undefined);
});

test('formatDietaryBrief: subject + body shape', () => {
  const { subject, body } = formatDietaryBrief({
    user: { fullName: 'Ust. Ahmad', email: 'a@x' },
    paket: { id: 'p1', slug: 'p1', title: 'Ramadhan 2026', departureDate: new Date('2026-04-01') },
    specials: [
      { bookingNo: 'B1', kelas: 'QUAD', paxCount: 1, jemaah: { fullName: 'Pak Budi', dietary: 'DIABETIC', dietaryNotes: 'no rice' }, room: { roomNo: 'M-401' } },
      { bookingNo: 'B2', kelas: 'QUAD', paxCount: 1, jemaah: { fullName: 'Bu Sari', dietary: 'VEGETARIAN', dietaryNotes: null }, room: null },
    ],
    tally: { REGULAR: 18, DIABETIC: 1, VEGETARIAN: 1 },
    totalPax: 20,
    specialPax: 2,
  });
  assert.match(subject, /Ramadhan 2026/);
  assert.match(body, /Halo Ust\. Ahmad/);
  assert.match(body, /DIABETIC/);
  assert.match(body, /no rice/);
  assert.match(body, /Pak Budi/);
  assert.match(body, /M-401/);
  assert.match(body, /VEGETARIAN/);
  assert.match(body, /20 pax/);
});

test('notifyCrewDietaryBrief: skips when crew has no email', async () => {
  const r = await notifyCrewDietaryBrief({
    user: { id: 'u1', fullName: 'X', email: null },
    paket: { id: 'p1', slug: 'p1', title: 'X', departureDate: new Date() },
    specials: [{ jemaah: { fullName: 'X', dietary: 'VEGETARIAN' } }],
    tally: {}, totalPax: 1, specialPax: 1,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_email');
});

test('notifyCrewDietaryBrief: skips when all REGULAR (zero specials)', async () => {
  const r = await notifyCrewDietaryBrief({
    user: { id: 'u1', fullName: 'X', email: 'crew@x' },
    paket: { id: 'p1', slug: 'p1', title: 'X', departureDate: new Date() },
    specials: [],
    tally: { REGULAR: 20 }, totalPax: 20, specialPax: 0,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'all_regular');
});

test('notifyCrewDietaryBrief: enqueues notif when specials present', async (t) => {
  const tag = makeTag('s213-enqueue');
  const crew = await tempMuthawwif(t, tag);
  const r = await notifyCrewDietaryBrief({
    user: { id: crew.id, fullName: 'X', email: crew.email },
    paket: { id: 'p1', slug: 'p1', title: 'X', departureDate: new Date() },
    specials: [
      { bookingNo: 'B1', kelas: 'QUAD', paxCount: 1, jemaah: { fullName: 'Pak Budi', dietary: 'DIABETIC' }, room: null },
    ],
    tally: { REGULAR: 1, DIABETIC: 1 }, totalPax: 2, specialPax: 1,
  });
  t.after(async () => {
    if (r.notifId) await db.notification.deleteMany({ where: { id: r.notifId } });
  });
  assert.equal(r.enqueued, true);
  assert.ok(r.notifId);

  const row = await db.notification.findUnique({ where: { id: r.notifId } });
  assert.equal(row.type, 'CREW_DIETARY_BRIEF');
  assert.equal(row.channel, 'EMAIL');
  assert.equal(row.recipientUserId, crew.id);
  assert.match(row.body, /DIABETIC/);
});
