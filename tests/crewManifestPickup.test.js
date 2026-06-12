// Stage 228 — pickup info on crew manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempMuthawwif, tempBooking } from './_helpers.js';
import { getAssignedManifest } from '../src/services/crewPortal.js';

async function assign(paket, crew) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
}
async function seedPickup(paket, label = 'Bekasi', departTime = '05:00') {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder: 0, departTime },
  });
}

test('getAssignedManifest: bookings carry pickup field', async (t) => {
  const tag = makeTag('s228-field');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const p = await seedPickup(paket, 'Bekasi');
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: p.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r.bookings[0].pickup.label, 'Bekasi');
  assert.equal(r.bookings[0].pickup.departTime, '05:00');
});

test('getAssignedManifest: bookings without pickup get null pickup field', async (t) => {
  const tag = makeTag('s228-null');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r.bookings[0].pickup, null);
});

test('getAssignedManifest: pickupSummary tallies pax per pickup', async (t) => {
  const tag = makeTag('s228-tally');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const pA = await seedPickup(paket, 'Bekasi');
  const pB = await seedPickup(paket, 'Bogor');
  const u = await tempJemaah(t, tag);
  const b1 = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b2.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b3.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  const bekasiRow = r.pickupSummary.find((p) => p.label === 'Bekasi');
  const bogorRow = r.pickupSummary.find((p) => p.label === 'Bogor');
  assert.equal(bekasiRow.paxCount, 2);
  assert.equal(bogorRow.paxCount, 1);
});

test('getAssignedManifest: pickupSummary TBD rendered LAST regardless of size', async (t) => {
  const tag = makeTag('s228-tbd-last');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const pA = await seedPickup(paket, 'Bekasi');
  const u = await tempJemaah(t, tag);
  // 1 booking on Bekasi
  const b1 = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pA.id } });
  // 3 bookings unchosen (TBD)
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  // Last row should be TBD (id=null) even though it has more pax (3) than Bekasi (1)
  const last = r.pickupSummary[r.pickupSummary.length - 1];
  assert.equal(last.id, null);
});

test('getAssignedManifest: CANCELLED bookings excluded from pickupSummary', async (t) => {
  const tag = makeTag('s228-cancel');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const pA = await seedPickup(paket, 'Bekasi');
  const u = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED', pickupId: pA.id,
    },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  const bekasi = r.pickupSummary.find((p) => p.label === 'Bekasi');
  // CANCELLED is excluded by the prior `where: { status: notIn: [...] }` clause,
  // so Bekasi shouldn't appear (no active bookings on it).
  assert.equal(bekasi, undefined);
});
