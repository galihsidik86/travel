// Stage 205 — manifest pickup count rollup + filter helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getManifestForPaket, filterManifestByPickup } from '../src/services/adminDashboard.js';

async function seedPickup(paket, label, sortOrder = 0) {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder },
  });
}

test('pickupCounts: empty when no pickups exist', async (t) => {
  const tag = makeTag('s205-empty');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const m = await getManifestForPaket(paket.slug);
  // No pickups defined → all bookings go to TBD bucket
  assert.equal(m.pickupCounts.length, 1);
  assert.equal(m.pickupCounts[0].label, 'TBD');
  assert.equal(m.pickupCounts[0].id, null);
});

test('pickupCounts: groups bookings by pickup choice', async (t) => {
  const tag = makeTag('s205-group');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const pB = await seedPickup(paket, 'Bogor');
  // 2 jemaah → Bekasi, 1 → Bogor, 1 → TBD
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id }); // TBD
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b2.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b3.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const m = await getManifestForPaket(paket.slug);
  const bekasi = m.pickupCounts.find((p) => p.label === 'Bekasi');
  const bogor = m.pickupCounts.find((p) => p.label === 'Bogor');
  const tbd = m.pickupCounts.find((p) => p.label === 'TBD');
  assert.equal(bekasi.paxCount, 2);
  assert.equal(bogor.paxCount, 1);
  assert.equal(tbd.paxCount, 1);
});

test('pickupCounts: TBD always last regardless of size', async (t) => {
  const tag = makeTag('s205-tbd-last');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  // 1 chose Bekasi, 5 TBD — TBD has more but should still be last
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pA.id } });
  for (let i = 0; i < 5; i++) {
    await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  }
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const m = await getManifestForPaket(paket.slug);
  assert.equal(m.pickupCounts[m.pickupCounts.length - 1].label, 'TBD');
});

test('pickupCounts: excludes CANCELLED/REFUNDED bookings', async (t) => {
  const tag = makeTag('s205-exclude');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: b1.id }, data: { pickupId: pA.id, status: 'CANCELLED' },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const m = await getManifestForPaket(paket.slug);
  const bekasi = m.pickupCounts.find((p) => p.label === 'Bekasi');
  assert.equal(bekasi, undefined, 'cancelled booking not counted');
});

test('filterManifestByPickup: narrows rows to a specific pickup', async (t) => {
  const tag = makeTag('s205-narrow');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const pB = await seedPickup(paket, 'Bogor');
  const bekasiBooking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const bogorBooking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: bekasiBooking.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: bogorBooking.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const m = await getManifestForPaket(paket.slug);
  const filtered = filterManifestByPickup(m, pA.id);
  const ids = filtered.bookings.map((b) => b.id);
  assert.ok(ids.includes(bekasiBooking.id));
  assert.ok(!ids.includes(bogorBooking.id));
  assert.equal(filtered.filteredByPickup, pA.id);
});

test('filterManifestByPickup: __TBD__ targets unchosen bookings', async (t) => {
  const tag = makeTag('s205-tbd-filter');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const chosen = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const tbd = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: chosen.id }, data: { pickupId: pA.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const m = await getManifestForPaket(paket.slug);
  const filtered = filterManifestByPickup(m, '__TBD__');
  const ids = filtered.bookings.map((b) => b.id);
  assert.ok(ids.includes(tbd.id));
  assert.ok(!ids.includes(chosen.id));
});

test('filterManifestByPickup: ALL or empty → pass-through', async (t) => {
  const tag = makeTag('s205-pass');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const m = await getManifestForPaket(paket.slug);

  const r1 = filterManifestByPickup(m, 'ALL');
  assert.equal(r1, m);

  const r2 = filterManifestByPickup(m, '');
  assert.equal(r2, m);

  const r3 = filterManifestByPickup(null, 'whatever');
  assert.equal(r3, null);
});
