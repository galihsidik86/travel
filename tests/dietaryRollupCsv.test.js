// Stage 211 — dietary roll-up CSV for catering kitchen brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { buildDietaryRollupCsv } from '../src/services/dietaryRollupCsv.js';

async function seedJemaahWithDiet(t, tag, dietary, dietaryNotes = null) {
  const u = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: u.jemaah.id },
    data: { dietary, dietaryNotes },
  });
  return u;
}

test('buildDietaryRollupCsv: unknown paket → null', async () => {
  const r = await buildDietaryRollupCsv('does-not-exist');
  assert.equal(r, null);
});

test('buildDietaryRollupCsv: empty paket → header + footer, no rows', async (t) => {
  const tag = makeTag('s211-empty');
  const paket = await tempPaket(t, tag);
  const r = await buildDietaryRollupCsv(paket.slug);
  assert.equal(r.rowCount, 0);
  assert.ok(r.csv.startsWith('\ufeff'));
  assert.match(r.csv, /bookingNo,jemaahName/);
  assert.match(r.csv, /REGULAR=0/);
});

test('buildDietaryRollupCsv: BOM + RFC 4180 + CRLF', async (t) => {
  const tag = makeTag('s211-format');
  const paket = await tempPaket(t, tag);
  const r = await buildDietaryRollupCsv(paket.slug);
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM');
  assert.match(r.csv, /\r\n/, 'CRLF row separators');
});

test('buildDietaryRollupCsv: REGULAR rows excluded from per-jemaah list', async (t) => {
  const tag = makeTag('s211-skip-regular');
  const paket = await tempPaket(t, tag);
  const reg = await tempJemaah(t, tag + '-reg');
  const veg = await seedJemaahWithDiet(t, tag + '-veg', 'VEGETARIAN');
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: veg.jemaah.id });

  const r = await buildDietaryRollupCsv(paket.slug);
  // Only VEGETARIAN should appear as a per-jemaah row
  assert.equal(r.rowCount, 1);
  assert.match(r.csv, /VEGETARIAN/);
  // Footer tally counts BOTH (REGULAR=1; VEGETARIAN=1)
  assert.match(r.csv, /REGULAR=1/);
  assert.match(r.csv, /VEGETARIAN=1/);
});

test('buildDietaryRollupCsv: groups by dietary code then jemaah name', async (t) => {
  const tag = makeTag('s211-sort');
  const paket = await tempPaket(t, tag);
  // DIABETIC (sort first by code)
  const diab1 = await seedJemaahWithDiet(t, tag + '-d-zara', 'DIABETIC');
  await db.jemaahProfile.update({ where: { id: diab1.jemaah.id }, data: { fullName: 'Zara' } });
  // VEGETARIAN (sort last by code)
  const veg = await seedJemaahWithDiet(t, tag + '-v-abdul', 'VEGETARIAN');
  await db.jemaahProfile.update({ where: { id: veg.jemaah.id }, data: { fullName: 'Abdul' } });
  await tempBooking({ paket, jemaahProfileId: diab1.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: veg.jemaah.id });

  const r = await buildDietaryRollupCsv(paket.slug);
  // DIABETIC code < VEGETARIAN alphabetically → Zara (DIAB) should appear before Abdul (VEG)
  const idxZara = r.csv.indexOf('Zara');
  const idxAbdul = r.csv.indexOf('Abdul');
  assert.ok(idxZara > 0 && idxAbdul > 0);
  assert.ok(idxZara < idxAbdul, 'DIABETIC group precedes VEGETARIAN group');
});

test('buildDietaryRollupCsv: CANCELLED/REFUNDED excluded', async (t) => {
  const tag = makeTag('s211-cancel');
  const paket = await tempPaket(t, tag);
  const veg = await seedJemaahWithDiet(t, tag, 'VEGETARIAN');
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: veg.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: b.id } }); });

  const r = await buildDietaryRollupCsv(paket.slug);
  assert.equal(r.rowCount, 0);
  // VEG not counted in tally either
  assert.doesNotMatch(r.csv, /VEGETARIAN=1/);
});

test('buildDietaryRollupCsv: dietaryNotes appear in per-row', async (t) => {
  const tag = makeTag('s211-notes');
  const paket = await tempPaket(t, tag);
  const diab = await seedJemaahWithDiet(t, tag, 'DIABETIC', 'no rice, sub with sweet potato');
  await tempBooking({ paket, jemaahProfileId: diab.jemaah.id });

  const r = await buildDietaryRollupCsv(paket.slug);
  assert.match(r.csv, /no rice, sub with sweet potato|"no rice, sub with sweet potato"/);
});

test('buildDietaryRollupCsv: tally + specialPax + totalPax in result', async (t) => {
  const tag = makeTag('s211-tally');
  const paket = await tempPaket(t, tag);
  const reg = await tempJemaah(t, tag + '-reg');
  const veg = await seedJemaahWithDiet(t, tag + '-veg', 'VEGETARIAN');
  await tempBooking({ paket, jemaahProfileId: reg.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: veg.jemaah.id });

  const r = await buildDietaryRollupCsv(paket.slug);
  assert.equal(r.tally.REGULAR, 1);
  assert.equal(r.tally.VEGETARIAN, 1);
  assert.equal(r.totalPax, 2);
  assert.equal(r.specialPax, 1);
});
