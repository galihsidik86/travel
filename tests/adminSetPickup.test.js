// Stage 221 — admin-side pickup setter on booking detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { adminSetBookingPickup } from '../src/services/bookingPickupChoice.js';

// id=null avoids the AuditLog actorUserId FK constraint (fake id triggers
// silent audit failure). email + role still snapshot for the trail.
const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function seedPickup(paket, label = 'Bekasi', maxCapacity = null) {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder: 0, maxCapacity },
  });
}

test('adminSetBookingPickup: 404 on unknown booking', async () => {
  await assert.rejects(
    () => adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: 'no-such', pickupId: null }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('adminSetBookingPickup: works WITHOUT jemaahUserId (walk-in booking)', async (t) => {
  const tag = makeTag('s221-walkin');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await seedPickup(paket);
  // Walk-in booking — no jemaahUserId
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await adminSetBookingPickup({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, pickupId: pickup.id,
  });
  assert.equal(r.updated, true);
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { pickupId: true } });
  assert.equal(after.pickupId, pickup.id);
});

test('adminSetBookingPickup: refuses cross-paket pickup', async (t) => {
  const tag = makeTag('s221-mismatch');
  const paketA = await tempPaket(t, tag + '-a');
  const paketB = await tempPaket(t, tag + '-b');
  const jem = await tempJemaah(t, tag);
  const pickupOnB = await seedPickup(paketB);
  // Booking on A, trying to set pickup that belongs to B
  const b = await tempBooking({ paket: paketA, jemaahProfileId: jem.jemaah.id });
  t.after(async () => {
    await db.paketPickup.deleteMany({ where: { paketId: { in: [paketA.id, paketB.id] } } });
  });

  await assert.rejects(
    () => adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: pickupOnB.id }),
    (err) => err.code === 'PICKUP_MISMATCH' && err.status === 400,
  );
});

test('adminSetBookingPickup: capacity guard refuses PICKUP_FULL', async (t) => {
  const tag = makeTag('s221-full');
  const paket = await tempPaket(t, tag);
  const jem1 = await tempJemaah(t, tag + '-1');
  const jem2 = await tempJemaah(t, tag + '-2');
  const pickup = await seedPickup(paket, 'Bekasi', 1);
  // jem1 already on it
  const b1 = await tempBooking({ paket, jemaahProfileId: jem1.jemaah.id });
  await db.booking.update({ where: { id: b1.id }, data: { pickupId: pickup.id } });
  // jem2 tries — admin sets
  const b2 = await tempBooking({ paket, jemaahProfileId: jem2.jemaah.id });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  await assert.rejects(
    () => adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b2.id, pickupId: pickup.id }),
    (err) => err.code === 'PICKUP_FULL' && err.status === 409,
  );
});

test('adminSetBookingPickup: refuses on CANCELLED booking', async (t) => {
  const tag = makeTag('s221-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await seedPickup(paket);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: b.id } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
  });

  await assert.rejects(
    () => adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: pickup.id }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('adminSetBookingPickup: null clears pickup (idempotent re-clear is no-op)', async (t) => {
  const tag = makeTag('s221-clear');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await seedPickup(paket);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: pickup.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r1 = await adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: null });
  assert.equal(r1.updated, true);
  // Re-clearing → no-op
  const r2 = await adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: null });
  assert.equal(r2.updated, false);
});

test('adminSetBookingPickup: idempotent re-set to same pickup (no audit pollution)', async (t) => {
  const tag = makeTag('s221-idempotent');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await seedPickup(paket);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: pickup.id } });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  const r = await adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: pickup.id });
  assert.equal(r.updated, false);
});

test('adminSetBookingPickup: writes audit row with adminSet:true marker', async (t) => {
  const tag = makeTag('s221-audit');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const pickup = await seedPickup(paket);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => { await db.paketPickup.deleteMany({ where: { paketId: paket.id } }); });

  await adminSetBookingPickup({ req: fakeReq, actor: adminActor, bookingId: b.id, pickupId: pickup.id });
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.adminSet, true);
  // NOT pickupChosen (that marker is for S202 jemaah self-pick)
  assert.equal(audits[0].after.pickupChosen, undefined);
});
