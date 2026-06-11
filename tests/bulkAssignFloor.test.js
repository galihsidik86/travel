// Stage 200 — bulk-assign unassigned bookings to rooms on a floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempRoom, fakeReq, systemActor } from './_helpers.js';
import { bulkAssignRoomsByFloor } from '../src/services/bunking.js';

test('bulkAssignRoomsByFloor: rejects missing paketId', async () => {
  await assert.rejects(
    bulkAssignRoomsByFloor({
      req: fakeReq, actor: systemActor, paketId: null, floor: 4,
    }),
    /BAD_INPUT|wajib/,
  );
});

test('bulkAssignRoomsByFloor: rejects non-numeric floor', async (t) => {
  const tag = makeTag('s200-badfloor');
  const paket = await tempPaket(t, tag);
  await assert.rejects(
    bulkAssignRoomsByFloor({
      req: fakeReq, actor: systemActor, paketId: paket.id, floor: 'four',
    }),
    /angka|BAD_INPUT/,
  );
});

test('bulkAssignRoomsByFloor: assigns matching kelas + capacity rooms', async (t) => {
  const tag = makeTag('s200-happy');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // 3 unassigned QUAD bookings on the same paket
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // 2 QUAD rooms on floor 4, capacity 4 each
  const r1 = await tempRoom(t, paket, { roomNo: 'F4-A', floor: 4, capacity: 4 });
  const r2 = await tempRoom(t, paket, { roomNo: 'F4-B', floor: 4, capacity: 4 });

  const result = await bulkAssignRoomsByFloor({
    req: fakeReq, actor: systemActor, paketId: paket.id, floor: 4,
  });
  // All 3 should fit (capacity 4 each, 1 pax each — 3 fit in r1, none needed r2)
  assert.equal(result.assigned.length, 3);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.errors.length, 0);

  // Confirm DB state
  const after = await db.booking.findMany({
    where: { id: { in: [b1.id, b2.id, b3.id] } },
    select: { id: true, roomId: true },
  });
  for (const b of after) assert.ok(b.roomId, 'booking has roomId');
});

test('bulkAssignRoomsByFloor: skips when no room on floor matches kelas', async (t) => {
  const tag = makeTag('s200-kelas');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // QUAD booking
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // DOUBLE-only rooms on floor 4
  await tempRoom(t, paket, { roomNo: 'D4-A', floor: 4, kelas: 'DOUBLE', capacity: 2 });

  const result = await bulkAssignRoomsByFloor({
    req: fakeReq, actor: systemActor, paketId: paket.id, floor: 4,
  });
  assert.equal(result.assigned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'no_matching_room');
});

test('bulkAssignRoomsByFloor: respects partial capacity from existing assignments', async (t) => {
  const tag = makeTag('s200-cap');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Room with 1 slot left (3 of 4 used)
  const room = await tempRoom(t, paket, { roomNo: 'F4-X', floor: 4, capacity: 4 });
  // Pre-fill via direct create so capacity is partially used
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-FILLED`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 3, totalAmount: '1000', paidAmount: '0',
      status: 'BOOKED', roomId: room.id,
    },
  });
  // Now create 2 unassigned: a 1-pax (should fit) + 1 a 2-pax (should NOT fit)
  const fits = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-FIT`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'PENDING',
    },
  });
  const oversized = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-BIG`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 2, totalAmount: '500', paidAmount: '0',
      status: 'PENDING',
      createdAt: new Date(Date.now() + 1000), // newer than `fits`
    },
  });

  const result = await bulkAssignRoomsByFloor({
    req: fakeReq, actor: systemActor, paketId: paket.id, floor: 4,
  });
  // The 1-pax fits the room, leaving 0 slots → the 2-pax can't fit
  assert.equal(result.assigned.length, 1);
  assert.equal(result.skipped.length, 1);
  const fitsAfter = await db.booking.findUnique({ where: { id: fits.id } });
  const oversizedAfter = await db.booking.findUnique({ where: { id: oversized.id } });
  assert.equal(fitsAfter.roomId, room.id);
  assert.equal(oversizedAfter.roomId, null);
});

test('bulkAssignRoomsByFloor: ignores CANCELLED/REFUNDED bookings', async (t) => {
  const tag = makeTag('s200-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  await tempRoom(t, paket, { roomNo: 'F4-Z', floor: 4, capacity: 4 });

  const result = await bulkAssignRoomsByFloor({
    req: fakeReq, actor: systemActor, paketId: paket.id, floor: 4,
  });
  assert.equal(result.assigned.length, 0, 'CANCELLED not picked');
  assert.equal(result.skipped.length, 0);
});

test('bulkAssignRoomsByFloor: writes one audit row per assigned booking', async (t) => {
  const tag = makeTag('s200-audit');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await tempRoom(t, paket, { roomNo: 'F4-AUD', floor: 4, capacity: 4 });

  await bulkAssignRoomsByFloor({
    req: fakeReq, actor: systemActor, paketId: paket.id, floor: 4,
  });
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
  });
  assert.ok(audits.length >= 1);
  const recent = audits[audits.length - 1];
  assert.equal(recent.after.bulkAssignByFloor, true);
  assert.equal(recent.after.floor, 4);
});
