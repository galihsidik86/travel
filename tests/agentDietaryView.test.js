// Stage 241 — agen-facing dietary view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import { getAgentDietaryView } from '../src/services/agentDietaryView.js';
import { hashPassword } from '../src/lib/auth.js';

async function makeAgent(t, tag) {
  const email = `${tag}-agen@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811',
    },
  });
  const profile = await db.agentProfile.create({
    data: {
      userId: user.id, slug: tag, displayName: `Agen ${tag}`,
      whatsapp: '+62811',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { agentId: profile.id } });
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, profile };
}

async function makePaket(t, tag, daysOut = 7) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 20, status: 'ACTIVE',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function makeBooking(paket, jemaahId, agentId, paxCount = 1) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId, agentId,
      kelas: 'QUAD', paxCount, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
}

async function setDiet(jemaahId, dietary, dietaryNotes = null) {
  await db.jemaahProfile.update({ where: { id: jemaahId }, data: { dietary, dietaryNotes } });
}

test('getAgentDietaryView: returns empty when agentId missing', async () => {
  const r = await getAgentDietaryView({});
  assert.deepEqual(r, { paket: [], totalPax: 0, totalSpecialPax: 0 });
});

test('getAgentDietaryView: empty result for agen with no soon-departing paket', async (t) => {
  const tag = makeTag('s241-empty');
  const { profile } = await makeAgent(t, tag);
  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.paket.length, 0);
  assert.equal(r.totalPax, 0);
});

test('getAgentDietaryView: groups bookings by paket + counts specials', async (t) => {
  const tag = makeTag('s241-group');
  const { profile } = await makeAgent(t, tag);
  const paket = await makePaket(t, tag, 7);
  const reg = await tempJemaah(t, tag + '-reg');
  const veg = await tempJemaah(t, tag + '-veg');
  const diab = await tempJemaah(t, tag + '-diab');
  await setDiet(veg.jemaah.id, 'VEGETARIAN');
  await setDiet(diab.jemaah.id, 'DIABETIC', 'no rice');
  await makeBooking(paket, reg.jemaah.id, profile.id);
  await makeBooking(paket, veg.jemaah.id, profile.id);
  await makeBooking(paket, diab.jemaah.id, profile.id);

  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.paket.length, 1);
  assert.equal(r.paket[0].totalPax, 3);
  assert.equal(r.paket[0].specialPax, 2);
  assert.equal(r.paket[0].specials.length, 2);
  // tally counts all 3
  assert.equal(r.paket[0].tally.REGULAR, 1);
  assert.equal(r.paket[0].tally.VEGETARIAN, 1);
  assert.equal(r.paket[0].tally.DIABETIC, 1);
});

test('getAgentDietaryView: only agen\'s OWN bookings (no leak)', async (t) => {
  const tag = makeTag('s241-isolate');
  const a1 = await makeAgent(t, tag + '-1');
  const a2 = await makeAgent(t, tag + '-2');
  const paket = await makePaket(t, tag, 7);
  const j1 = await tempJemaah(t, tag + '-j1');
  const j2 = await tempJemaah(t, tag + '-j2');
  await setDiet(j1.jemaah.id, 'VEGETARIAN');
  await setDiet(j2.jemaah.id, 'DIABETIC');
  await makeBooking(paket, j1.jemaah.id, a1.profile.id);
  await makeBooking(paket, j2.jemaah.id, a2.profile.id);

  const r = await getAgentDietaryView({ agentId: a1.profile.id });
  // a1 only sees their own jemaah (veg)
  assert.equal(r.totalPax, 1);
  assert.equal(r.totalSpecialPax, 1);
  assert.equal(r.paket[0].specials[0].jemaah.dietary, 'VEGETARIAN');
});

test('getAgentDietaryView: walk-in (agentId=null) bookings NOT visible to any agen', async (t) => {
  const tag = makeTag('s241-walkin');
  const { profile } = await makeAgent(t, tag);
  const paket = await makePaket(t, tag, 7);
  const u = await tempJemaah(t, tag);
  await setDiet(u.jemaah.id, 'DIABETIC');
  // Walk-in booking (agentId=null)
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-walkin`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'PENDING',
    },
  });

  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.totalPax, 0);
});

test('getAgentDietaryView: paket OUTSIDE window excluded', async (t) => {
  const tag = makeTag('s241-far');
  const { profile } = await makeAgent(t, tag);
  const paket = await makePaket(t, tag, 30); // beyond 14d
  const u = await tempJemaah(t, tag);
  await setDiet(u.jemaah.id, 'VEGETARIAN');
  await makeBooking(paket, u.jemaah.id, profile.id);

  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.paket.length, 0);
});

test('getAgentDietaryView: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s241-cancel');
  const { profile } = await makeAgent(t, tag);
  const paket = await makePaket(t, tag, 7);
  const u = await tempJemaah(t, tag);
  await setDiet(u.jemaah.id, 'VEGETARIAN');
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-c`, paketId: paket.id, jemaahId: u.jemaah.id, agentId: profile.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'CANCELLED',
    },
  });

  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.paket.length, 0);
});

test('getAgentDietaryView: paket with specials sorts BEFORE paket with only REGULAR', async (t) => {
  const tag = makeTag('s241-sort');
  const { profile } = await makeAgent(t, tag);
  // paket A: only REGULAR jemaah, departing sooner
  const paketA = await makePaket(t, tag + '-a', 5);
  // paket B: has DIABETIC jemaah, departing later
  const paketB = await makePaket(t, tag + '-b', 10);

  const regJ = await tempJemaah(t, tag + '-reg');
  const diabJ = await tempJemaah(t, tag + '-diab');
  await setDiet(diabJ.jemaah.id, 'DIABETIC');

  await makeBooking(paketA, regJ.jemaah.id, profile.id);
  await makeBooking(paketB, diabJ.jemaah.id, profile.id);

  const r = await getAgentDietaryView({ agentId: profile.id });
  assert.equal(r.paket.length, 2);
  // Paket with specials first
  assert.equal(r.paket[0].paket.slug, paketB.slug);
  assert.equal(r.paket[1].paket.slug, paketA.slug);
});
