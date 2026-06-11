// Stage 178 — swapBookingRooms swaps two bookings' room assignments
// in one transaction, with symmetric capacity + kelas validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempRoom, fakeReq, systemActor } from './_helpers.js';
import { swapBookingRooms, assignBookingToRoom } from '../src/services/bunking.js';

async function bookingInRoom({ paket, jemaahProfileId, room, kelas = 'QUAD', paxCount = 1 }) {
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId: jemaahProfileId,
      kelas, paxCount, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      roomId: room?.id || null,
    },
  });
  return b;
}

test('swapBookingRooms: rejects same booking pair', async (t) => {
  const tag = makeTag('s178-same');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const room = await tempRoom(t, paket, { roomNo: 'R1' });
  const b = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room });
  await assert.rejects(
    swapBookingRooms({
      req: fakeReq, actor: systemActor,
      bookingIdA: b.id, bookingIdB: b.id,
    }),
    /BAD_SWAP_PAIR|berbeda/,
  );
});

test('swapBookingRooms: rejects cross-paket pair', async (t) => {
  const tag = makeTag('s178-cross');
  const paketA = await tempPaket(t, makeTag(`${tag}-A`));
  const paketB = await tempPaket(t, makeTag(`${tag}-B`));
  const jem = await tempJemaah(t, tag);
  const rA = await tempRoom(t, paketA, { roomNo: 'A1' });
  const rB = await tempRoom(t, paketB, { roomNo: 'B1' });
  const bA = await bookingInRoom({ paket: paketA, jemaahProfileId: jem.jemaah.id, room: rA });
  const bB = await bookingInRoom({ paket: paketB, jemaahProfileId: jem.jemaah.id, room: rB });
  await assert.rejects(
    swapBookingRooms({ req: fakeReq, actor: systemActor, bookingIdA: bA.id, bookingIdB: bB.id }),
    /PAKET_MISMATCH|paket/,
  );
});

test('swapBookingRooms: rejects CANCELLED booking', async (t) => {
  const tag = makeTag('s178-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const r1 = await tempRoom(t, paket, { roomNo: 'R-A' });
  const r2 = await tempRoom(t, paket, { roomNo: 'R-B' });
  const b1 = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: r1 });
  const b2 = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'CANCELLED', roomId: r2.id,
    },
  });
  await assert.rejects(
    swapBookingRooms({ req: fakeReq, actor: systemActor, bookingIdA: b1.id, bookingIdB: b2.id }),
    /BOOKING_CLOSED|cancelled/i,
  );
});

test('swapBookingRooms: same-room → no-op', async (t) => {
  const tag = makeTag('s178-noop');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const room = await tempRoom(t, paket, { roomNo: 'R1', capacity: 4 });
  const b1 = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room });
  const b2 = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room });
  const r = await swapBookingRooms({
    req: fakeReq, actor: systemActor, bookingIdA: b1.id, bookingIdB: b2.id,
  });
  assert.equal(r.swapped, false);
  assert.equal(r.reason, 'same_room');
});

test('swapBookingRooms: happy path swaps two bookings', async (t) => {
  const tag = makeTag('s178-happy');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const rA = await tempRoom(t, paket, { roomNo: 'R-A', capacity: 4 });
  const rB = await tempRoom(t, paket, { roomNo: 'R-B', capacity: 4 });
  const bA = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rA });
  const bB = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rB });

  const r = await swapBookingRooms({
    req: fakeReq, actor: systemActor, bookingIdA: bA.id, bookingIdB: bB.id,
  });
  assert.equal(r.swapped, true);

  const [afterA, afterB] = await Promise.all([
    db.booking.findUnique({ where: { id: bA.id }, select: { roomId: true } }),
    db.booking.findUnique({ where: { id: bB.id }, select: { roomId: true } }),
  ]);
  assert.equal(afterA.roomId, rB.id, 'A moved to B\'s old room');
  assert.equal(afterB.roomId, rA.id, 'B moved to A\'s old room');
});

test('swapBookingRooms: rejects kelas mismatch on destination', async (t) => {
  const tag = makeTag('s178-kelas');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const rQuad = await tempRoom(t, paket, { roomNo: 'R-Q', kelas: 'QUAD', capacity: 4 });
  const rDouble = await tempRoom(t, paket, { roomNo: 'R-D', kelas: 'DOUBLE', capacity: 2 });
  const bQ = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rQuad, kelas: 'QUAD' });
  const bD = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rDouble, kelas: 'DOUBLE' });
  await assert.rejects(
    swapBookingRooms({ req: fakeReq, actor: systemActor, bookingIdA: bQ.id, bookingIdB: bD.id }),
    /KELAS_MISMATCH|tidak cocok/,
  );
});

test('swapBookingRooms: rejects when destination capacity would overflow', async (t) => {
  const tag = makeTag('s178-cap');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Room A: capacity 1, occupied by single-pax booking bA
  // Room B: capacity 2, occupied by 2-pax booking bB
  // Swap would put bB (2 pax) into A (capacity 1) — should reject
  const rA = await tempRoom(t, paket, { roomNo: 'R-A', capacity: 1 });
  const rB = await tempRoom(t, paket, { roomNo: 'R-B', capacity: 2 });
  const bA = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rA, paxCount: 1 });
  const bB = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: rB, paxCount: 2 });

  await assert.rejects(
    swapBookingRooms({ req: fakeReq, actor: systemActor, bookingIdA: bA.id, bookingIdB: bB.id }),
    /CAPACITY_EXCEEDED|kapasitas/i,
  );
});

test('swapBookingRooms: unassigned + assigned → promotes the unassigned one', async (t) => {
  const tag = makeTag('s178-promote');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const room = await tempRoom(t, paket, { roomNo: 'R1', capacity: 4 });
  const assigned = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room });
  const unassigned = await bookingInRoom({ paket, jemaahProfileId: jem.jemaah.id, room: null });

  const r = await swapBookingRooms({
    req: fakeReq, actor: systemActor,
    bookingIdA: assigned.id, bookingIdB: unassigned.id,
  });
  assert.equal(r.swapped, true);
  const [afterAssigned, afterUnassigned] = await Promise.all([
    db.booking.findUnique({ where: { id: assigned.id }, select: { roomId: true } }),
    db.booking.findUnique({ where: { id: unassigned.id }, select: { roomId: true } }),
  ]);
  assert.equal(afterAssigned.roomId, null);
  assert.equal(afterUnassigned.roomId, room.id);
});
