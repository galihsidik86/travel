// Stage 208 — pickup roster CSV export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { buildPickupRosterCsv } from '../src/services/pickupRosterCsv.js';

async function seedPickup(paket, label, { sortOrder = 0, departTime = null } = {}) {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder, departTime },
  });
}

test('buildPickupRosterCsv: unknown paket → null', async () => {
  const r = await buildPickupRosterCsv('does-not-exist');
  assert.equal(r, null);
});

test('buildPickupRosterCsv: empty paket → header + footer only', async (t) => {
  const tag = makeTag('s208-empty');
  const paket = await tempPaket(t, tag);
  const r = await buildPickupRosterCsv(paket.slug);
  assert.equal(r.rowCount, 0);
  assert.ok(r.csv.startsWith('\ufeff'));
  assert.match(r.csv, /pickup,departTime,address/);
  assert.match(r.csv, /TOTAL/);
});

test('buildPickupRosterCsv: BOM + RFC 4180 + CRLF', async (t) => {
  const tag = makeTag('s208-format');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const r = await buildPickupRosterCsv(paket.slug);
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM');
  assert.match(r.csv, /\r\n/, 'CRLF row separators');
});

test('buildPickupRosterCsv: groups + sorts by pickup sortOrder', async (t) => {
  const tag = makeTag('s208-sort');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bogor', { sortOrder: 5 });
  const pB = await seedPickup(paket, 'Bekasi', { sortOrder: 1 });
  // 1 booking each on different pickups
  const bA = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const bB = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: bA.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: bB.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug);
  // Bekasi (sortOrder 1) should appear before Bogor (sortOrder 5)
  const idxBekasi = r.csv.indexOf('Bekasi');
  const idxBogor = r.csv.indexOf('Bogor');
  assert.ok(idxBekasi > 0 && idxBogor > 0);
  assert.ok(idxBekasi < idxBogor, 'Bekasi (lower sortOrder) renders first');
});

test('buildPickupRosterCsv: TBD bucket renders last', async (t) => {
  const tag = makeTag('s208-tbd');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Tangerang', { sortOrder: 1 });
  const bWithPickup = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: bWithPickup.id }, data: { pickupId: pA.id } });
  // Booking without pickup
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug);
  // Tangerang label appears before TBD label
  const idxTang = r.csv.indexOf('Tangerang');
  const idxTbd = r.csv.indexOf('TBD');
  assert.ok(idxTang > 0 && idxTbd > 0);
  assert.ok(idxTang < idxTbd);
});

test('buildPickupRosterCsv: pickupId filter narrows to one pickup', async (t) => {
  const tag = makeTag('s208-filter');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const pB = await seedPickup(paket, 'Bogor');
  const bA = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const bB = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: bA.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: bB.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug, { pickupId: pA.id });
  // Bekasi row appears; Bogor row does NOT
  assert.match(r.csv, /Bekasi/);
  assert.ok(!r.csv.includes('Bogor'), 'filtered to Bekasi only');
  assert.equal(r.rowCount, 1);
});

test('buildPickupRosterCsv: __TBD__ filter → only unchosen bookings', async (t) => {
  const tag = makeTag('s208-tbd-filter');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const bChosen = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const bTbd = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: bChosen.id }, data: { pickupId: pA.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug, { pickupId: '__TBD__' });
  assert.equal(r.rowCount, 1);
  assert.ok(!r.csv.includes('Bekasi'), 'chosen booking excluded');
});

test('buildPickupRosterCsv: CANCELLED/REFUNDED excluded', async (t) => {
  const tag = makeTag('s208-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi');
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED', pickupId: pA.id,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: cancelled.id } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await buildPickupRosterCsv(paket.slug);
  assert.equal(r.rowCount, 0);
});

test('buildPickupRosterCsv: footer summary lists per-pickup counts', async (t) => {
  const tag = makeTag('s208-summary');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi', { sortOrder: 1 });
  const pB = await seedPickup(paket, 'Bogor', { sortOrder: 2 });
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b2.id }, data: { pickupId: pA.id } });
  await db.booking.update({ where: { id: b3.id }, data: { pickupId: pB.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await buildPickupRosterCsv(paket.slug);
  // Footer should include "Bekasi=2; Bogor=1"
  assert.match(r.csv, /Bekasi=2/);
  assert.match(r.csv, /Bogor=1/);
});
