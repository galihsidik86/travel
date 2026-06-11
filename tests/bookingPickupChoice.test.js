// Stage 202 — jemaah picks a pickup point on their booking.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { setMyBookingPickup } from '../src/services/bookingPickupChoice.js';
import { hashPassword } from '../src/lib/auth.js';

async function jemaahUserWithBooking(t, tag) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 5)}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `J ${tag}`, phone: '+62811',
      jemaah: { create: { fullName: `J ${tag}`, phone: '+62811' } },
    },
    include: { jemaah: true },
  });
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id,
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
    await db.jemaahProfile.deleteMany({ where: { id: user.jemaah.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, paket, booking };
}

test('setMyBookingPickup: cross-user booking → 404', async (t) => {
  const tag = makeTag('s202-x');
  const { booking } = await jemaahUserWithBooking(t, tag);
  // Different user — should NOT be able to set pickup on this booking
  await assert.rejects(
    setMyBookingPickup({
      req: fakeReq, actor: systemActor,
      userId: 'different-user-id', bookingId: booking.id, pickupId: null,
    }),
    /BOOKING_NOT_FOUND|tidak ditemukan/,
  );
});

test('setMyBookingPickup: null sets pickup to null (idempotent)', async (t) => {
  const tag = makeTag('s202-null');
  const { user, booking } = await jemaahUserWithBooking(t, tag);
  const r = await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: null,
  });
  // Booking starts with null pickup so this is a no-op
  assert.equal(r.updated, false);
});

test('setMyBookingPickup: picks valid pickup + writes audit', async (t) => {
  const tag = makeTag('s202-pick');
  const { user, paket, booking } = await jemaahUserWithBooking(t, tag);
  const pickup = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'Bekasi', address: 'Jl Ahmad Yani' },
  });
  const r = await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pickup.id,
  });
  assert.equal(r.updated, true);

  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.pickupId, pickup.id);

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
  });
  assert.ok(audits.length >= 1);
  assert.equal(audits[audits.length - 1].after.pickupChosen, true);
});

test('setMyBookingPickup: cross-paket pickup → PICKUP_MISMATCH', async (t) => {
  const tag = makeTag('s202-x-paket');
  const { user, booking } = await jemaahUserWithBooking(t, tag);
  // Create a pickup on a different paket
  const otherPaket = await tempPaket(t, makeTag(`${tag}-other`));
  const otherPickup = await db.paketPickup.create({
    data: { paketId: otherPaket.id, label: 'Bogor', address: 'Jl Pajajaran' },
  });
  t.after(async () => {
    await db.paketPickup.deleteMany({ where: { id: otherPickup.id } });
  });
  await assert.rejects(
    setMyBookingPickup({
      req: fakeReq, actor: systemActor,
      userId: user.id, bookingId: booking.id, pickupId: otherPickup.id,
    }),
    /PICKUP_MISMATCH|bukan milik/,
  );
});

test('setMyBookingPickup: unknown pickup → PICKUP_NOT_FOUND', async (t) => {
  const tag = makeTag('s202-unknown');
  const { user, booking } = await jemaahUserWithBooking(t, tag);
  await assert.rejects(
    setMyBookingPickup({
      req: fakeReq, actor: systemActor,
      userId: user.id, bookingId: booking.id, pickupId: 'does-not-exist',
    }),
    /PICKUP_NOT_FOUND|tidak ditemukan/,
  );
});

test('setMyBookingPickup: re-picking same → no-op (updated:false)', async (t) => {
  const tag = makeTag('s202-same');
  const { user, paket, booking } = await jemaahUserWithBooking(t, tag);
  const pickup = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'Tangerang', address: 'Jl Daan' },
  });
  await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pickup.id,
  });
  const r = await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pickup.id,
  });
  assert.equal(r.updated, false);
});

test('setMyBookingPickup: switching from A to B updates', async (t) => {
  const tag = makeTag('s202-switch');
  const { user, paket, booking } = await jemaahUserWithBooking(t, tag);
  const pA = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'A', address: 'Addr A' },
  });
  const pB = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'B', address: 'Addr B' },
  });
  await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pA.id,
  });
  await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pB.id,
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.pickupId, pB.id);
});

test('setMyBookingPickup: CANCELLED booking → BOOKING_CLOSED', async (t) => {
  const tag = makeTag('s202-cancel');
  const { user, paket, booking } = await jemaahUserWithBooking(t, tag);
  await db.booking.update({
    where: { id: booking.id }, data: { status: 'CANCELLED' },
  });
  const pickup = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'X', address: 'X' },
  });
  await assert.rejects(
    setMyBookingPickup({
      req: fakeReq, actor: systemActor,
      userId: user.id, bookingId: booking.id, pickupId: pickup.id,
    }),
    /BOOKING_CLOSED|cancelled/i,
  );
});

test('setMyBookingPickup: SetNull cascade when pickup deleted', async (t) => {
  const tag = makeTag('s202-cascade');
  const { user, paket, booking } = await jemaahUserWithBooking(t, tag);
  const pickup = await db.paketPickup.create({
    data: { paketId: paket.id, label: 'D', address: 'D' },
  });
  await setMyBookingPickup({
    req: fakeReq, actor: systemActor,
    userId: user.id, bookingId: booking.id, pickupId: pickup.id,
  });
  // Delete the pickup; the booking's pickupId should fall back to null
  await db.paketPickup.delete({ where: { id: pickup.id } });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.pickupId, null);
});
