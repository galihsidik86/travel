// Stage 244 — crew-side on-demand dietary brief CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempMuthawwif, tempBooking } from './_helpers.js';
import { buildCrewDietaryCsv } from '../src/services/crewDietaryCsv.js';

async function assign(paket, crew) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
}

async function setDiet(jemaahId, dietary, dietaryNotes = null) {
  await db.jemaahProfile.update({ where: { id: jemaahId }, data: { dietary, dietaryNotes } });
}

test('buildCrewDietaryCsv: unknown paket → null', async (t) => {
  const tag = makeTag('s244-unknown');
  const crew = await tempMuthawwif(t, tag);
  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: 'does-not-exist' });
  assert.equal(r, null);
});

test('buildCrewDietaryCsv: crew NOT on paket → notAssigned', async (t) => {
  const tag = makeTag('s244-notassigned');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  // No assignment

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  assert.equal(r.notAssigned, true);
});

test('buildCrewDietaryCsv: assigned crew gets the CSV', async (t) => {
  const tag = makeTag('s244-ok');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const reg = await tempJemaah(t, tag + '-reg');
  const veg = await tempJemaah(t, tag + '-veg');
  await setDiet(veg.jemaah.id, 'VEGETARIAN');
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: veg.jemaah.id });

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  assert.ok(r.csv);
  assert.ok(r.csv.startsWith('\ufeff'));
  assert.match(r.csv, /\r\n/);
  assert.equal(r.rowCount, 1); // only the VEG row
  assert.equal(r.totalPax, 2);
  assert.equal(r.specialPax, 1);
});

test('buildCrewDietaryCsv: footer tally includes REGULAR and per-category counts', async (t) => {
  const tag = makeTag('s244-tally');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const reg = await tempJemaah(t, tag + '-reg');
  const diab = await tempJemaah(t, tag + '-diab');
  await setDiet(diab.jemaah.id, 'DIABETIC', 'low sugar');
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: diab.jemaah.id });

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  assert.match(r.csv, /REGULAR=1/);
  assert.match(r.csv, /DIABETIC=1/);
  assert.match(r.csv, /TOTAL PAX=2/);
  assert.match(r.csv, /low sugar/);
});

test('buildCrewDietaryCsv: REGULAR rows excluded from per-jemaah list', async (t) => {
  const tag = makeTag('s244-skipreg');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const reg = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  assert.equal(r.rowCount, 0);
  // Header + only footer (3 lines after the \ufeff prefix split)
  const lines = r.csv.split('\r\n');
  // [header, footer] = 2 lines
  assert.equal(lines.length, 2);
});

test('buildCrewDietaryCsv: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s244-cancel');
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

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  assert.equal(r.rowCount, 0);
});

test('buildCrewDietaryCsv: sorts by dietary code then jemaah name', async (t) => {
  const tag = makeTag('s244-sort');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  // Two jemaah — Zara on DIABETIC, Abdul on VEGETARIAN. Code-sort
  // gives DIABETIC before VEGETARIAN.
  const zara = await tempJemaah(t, tag + '-zara');
  const abdul = await tempJemaah(t, tag + '-abdul');
  await db.jemaahProfile.update({ where: { id: zara.jemaah.id }, data: { fullName: 'Zara', dietary: 'DIABETIC' } });
  await db.jemaahProfile.update({ where: { id: abdul.jemaah.id }, data: { fullName: 'Abdul', dietary: 'VEGETARIAN' } });
  await tempBooking({ paket, jemaahProfileId: zara.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: abdul.jemaah.id });

  const r = await buildCrewDietaryCsv({ userId: crew.id, paketSlug: paket.slug });
  const idxZara = r.csv.indexOf('Zara');
  const idxAbdul = r.csv.indexOf('Abdul');
  assert.ok(idxZara > 0 && idxAbdul > 0);
  assert.ok(idxZara < idxAbdul);
});
