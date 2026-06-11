// Stage 214 — crew portal dietary panel. Read-only roll-up on
// /crew/paket/:slug so muthawwif sees the brief in-portal too.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempMuthawwif, tempBooking } from './_helpers.js';
import { getAssignedManifest } from '../src/services/crewPortal.js';

async function setDiet(jemaahId, dietary, dietaryNotes = null) {
  await db.jemaahProfile.update({ where: { id: jemaahId }, data: { dietary, dietaryNotes } });
}

async function assign(paket, crew) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
}

test('getAssignedManifest: dietarySummary present + tally counts REGULAR', async (t) => {
  const tag = makeTag('s214-default');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.ok(r.dietarySummary);
  assert.equal(r.dietarySummary.totalPax, 1);
  assert.equal(r.dietarySummary.specialPax, 0);
  assert.equal(r.dietarySummary.tally.REGULAR, 1);
  assert.equal(r.dietarySummary.specials.length, 0);
});

test('getAssignedManifest: specials list excludes REGULAR + sorts by dietary code', async (t) => {
  const tag = makeTag('s214-sort');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const reg = await tempJemaah(t, tag + '-reg');
  const veg = await tempJemaah(t, tag + '-veg');
  const diab = await tempJemaah(t, tag + '-diab');
  await setDiet(veg.jemaah.id, 'VEGETARIAN');
  await setDiet(diab.jemaah.id, 'DIABETIC');
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: veg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: diab.jemaah.id });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r.dietarySummary.specials.length, 2);
  // DIABETIC sorts before VEGETARIAN
  assert.equal(r.dietarySummary.specials[0].jemaah.dietary, 'DIABETIC');
  assert.equal(r.dietarySummary.specials[1].jemaah.dietary, 'VEGETARIAN');
  assert.equal(r.dietarySummary.specialPax, 2);
  assert.equal(r.dietarySummary.totalPax, 3);
  assert.equal(r.dietarySummary.tally.REGULAR, 1);
  assert.equal(r.dietarySummary.tally.DIABETIC, 1);
  assert.equal(r.dietarySummary.tally.VEGETARIAN, 1);
});

test('getAssignedManifest: CANCELLED bookings excluded from dietarySummary', async (t) => {
  const tag = makeTag('s214-cancel');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const veg = await tempJemaah(t, tag);
  await setDiet(veg.jemaah.id, 'VEGETARIAN');
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: veg.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'CANCELLED',
    },
  });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r.dietarySummary.specials.length, 0);
  assert.equal(r.dietarySummary.totalPax, 0);
});

test('getAssignedManifest: returns null when crew not assigned (no summary leakage)', async (t) => {
  const tag = makeTag('s214-unassigned');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  // No assignment

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r, null);
});
