// Stage 212 — pickup point capacity cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { PickupSchema, listPickupsWithOccupancy } from '../src/services/paketPickups.js';
import { setMyBookingPickup } from '../src/services/bookingPickupChoice.js';

async function seedPickup(paket, label, maxCapacity = null, sortOrder = 0) {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder, maxCapacity },
  });
}

test('PickupSchema: maxCapacity accepts 1..200, rejects 0 / 201', () => {
  assert.ok(PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: 1 }));
  assert.ok(PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: 200 }));
  assert.ok(PickupSchema.parse({ label: 'XY', address: 'addr1' })); // omitted ok
  assert.ok(PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: null })); // null clear
  assert.ok(PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: '' })); // empty → null

  assert.throws(() => PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: 0 }));
  assert.throws(() => PickupSchema.parse({ label: 'XY', address: 'addr1', maxCapacity: 201 }));
});

test('listPickupsWithOccupancy: empty paket → empty array', async (t) => {
  const tag = makeTag('s212-empty');
  const paket = await tempPaket(t, tag);
  const r = await listPickupsWithOccupancy(paket.id);
  assert.deepEqual(r, []);
});

test('listPickupsWithOccupancy: NULL maxCapacity → isFull=false regardless of occupancy', async (t) => {
  const tag = makeTag('s212-nocap');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const p = await seedPickup(paket, 'Bekasi', null);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: p.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const rows = await listPickupsWithOccupancy(paket.id);
  assert.equal(rows[0].maxCapacity, null);
  assert.equal(rows[0].occupiedPax, 1);
  assert.equal(rows[0].isFull, false);
});

test('listPickupsWithOccupancy: isFull=true when at cap', async (t) => {
  const tag = makeTag('s212-full');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const p = await seedPickup(paket, 'Bekasi', 2);
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: p.id } });
  await db.booking.update({ where: { id: b2.id }, data: { pickupId: p.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const rows = await listPickupsWithOccupancy(paket.id);
  assert.equal(rows[0].occupiedPax, 2);
  assert.equal(rows[0].isFull, true);
});

test('listPickupsWithOccupancy: CANCELLED/REFUNDED bookings not counted', async (t) => {
  const tag = makeTag('s212-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const p = await seedPickup(paket, 'Bekasi', 2);
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const cancelled = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED', pickupId: p.id,
    },
  });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: p.id } });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: cancelled.id } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });

  const rows = await listPickupsWithOccupancy(paket.id);
  assert.equal(rows[0].occupiedPax, 1, 'CANCELLED excluded');
  assert.equal(rows[0].isFull, false);
});

test('setMyBookingPickup: refuses PICKUP_FULL when at cap', async (t) => {
  const tag = makeTag('s212-refuse');
  const paket = await tempPaket(t, tag);
  const jem1 = await tempJemaah(t, tag + '-1');
  const jem2 = await tempJemaah(t, tag + '-2');
  const p = await seedPickup(paket, 'Bekasi', 1);
  // jem1 already on the pickup, fills the cap
  const b1 = await tempBooking({ paket, jemaahProfileId: jem1.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: p.id, jemaahUserId: jem1.id } });
  // jem2 tries to pick it
  const b2 = await tempBooking({ paket, jemaahProfileId: jem2.jemaah.id });
  await db.booking.update({ where: { id: b2.id }, data: { jemaahUserId: jem2.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const actor = { id: jem2.id, email: jem2.email, role: 'JEMAAH' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  await assert.rejects(
    () => setMyBookingPickup({ req, actor, userId: jem2.id, bookingId: b2.id, pickupId: p.id }),
    (err) => err.code === 'PICKUP_FULL' && err.status === 409,
  );
});

test('setMyBookingPickup: re-picking own pickup is no-op (does NOT double-count)', async (t) => {
  // Edge case: jemaah re-clicks their already-chosen pickup. The capacity
  // guard's "exclude current booking" rule means re-pick succeeds even
  // when at cap.
  const tag = makeTag('s212-self');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const p = await seedPickup(paket, 'Bekasi', 1);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: b.id },
    data: { jemaahUserId: jem.id, pickupId: p.id },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  // Re-pick the same one → idempotent no-op (no PICKUP_FULL fired)
  const r = await setMyBookingPickup({ req, actor, userId: jem.id, bookingId: b.id, pickupId: p.id });
  assert.equal(r.updated, false);
});

test('setMyBookingPickup: switch FROM full pickup TO empty other is allowed', async (t) => {
  const tag = makeTag('s212-switch');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pA = await seedPickup(paket, 'Bekasi', 1);
  const pB = await seedPickup(paket, 'Bogor', 1);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: b.id },
    data: { jemaahUserId: jem.id, pickupId: pA.id },
  });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const req = { ip: '127.0.0.1', get: () => 'test' };

  // Move to pB; pA was at cap but jem was the occupant
  const r = await setMyBookingPickup({ req, actor, userId: jem.id, bookingId: b.id, pickupId: pB.id });
  assert.equal(r.updated, true);
});
