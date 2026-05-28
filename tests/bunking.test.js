// Bunking (room assignment) tests.
//   - kelas mismatch refused
//   - capacity guard (sum of paxCount in room ≤ capacity)
//   - no-op reassign (same room) doesn't double-count its own paxCount
//   - cross-paket booking/room refused
//   - CANCELLED booking refused
//   - unassign clears Booking.roomId, no-op when already null
//   - getBunkingForPaket math: occupied = sum of active booking paxCount
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  db, makeTag, tempJemaah, tempPaket, tempBooking, tempRoom, fakeReq, systemActor,
} from './_helpers.js';
import {
  assignBookingToRoom, unassignBooking, getBunkingForPaket,
} from '../src/services/bunking.js';

const ctx = { req: fakeReq, actor: systemActor };

describe('assignBookingToRoom — validation', () => {
  test('PAKET_MISMATCH when booking and room belong to different paket', async (t) => {
    const tag = makeTag('bunk-cross');
    const user = await tempJemaah(t, tag);
    const paketA = await tempPaket(t, `${tag}-a`);
    const paketB = await tempPaket(t, `${tag}-b`);
    const booking = await tempBooking({ paket: paketA, jemaahProfileId: user.jemaah.id });
    const roomB = await tempRoom(t, paketB, { kelas: 'QUAD', capacity: 4 });

    await assert.rejects(
      assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: roomB.id }),
      (err) => err.code === 'PAKET_MISMATCH',
    );
  });

  test('KELAS_MISMATCH when booking kelas != room kelas', async (t) => {
    const tag = makeTag('bunk-kelas');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id }); // kelas=QUAD
    const room = await tempRoom(t, paket, { kelas: 'TRIPLE', capacity: 3 });

    await assert.rejects(
      assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: room.id }),
      (err) => err.code === 'KELAS_MISMATCH',
    );
  });

  test('BOOKING_CLOSED when booking is CANCELLED', async (t) => {
    const tag = makeTag('bunk-cancelled');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id });
    const room = await tempRoom(t, paket);
    await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });

    await assert.rejects(
      assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: room.id }),
      (err) => err.code === 'BOOKING_CLOSED',
    );
  });

  test('CAPACITY_EXCEEDED when sum of paxCount > room.capacity', async (t) => {
    const tag = makeTag('bunk-cap');
    const userA = await tempJemaah(t, `${tag}-a`);
    const userB = await tempJemaah(t, `${tag}-b`);
    const paket = await tempPaket(t, tag);
    // QUAD capacity=4. Two bookings with paxCount=3 each → 6 > 4
    const bookingA = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: userA.jemaah.id,
        kelas: 'QUAD', paxCount: 3, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    const bookingB = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: userB.jemaah.id,
        kelas: 'QUAD', paxCount: 3, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    const room = await tempRoom(t, paket, { kelas: 'QUAD', capacity: 4 });

    await assignBookingToRoom({ ...ctx, bookingId: bookingA.id, roomId: room.id }); // 3/4 — OK
    await assert.rejects(
      assignBookingToRoom({ ...ctx, bookingId: bookingB.id, roomId: room.id }),
      (err) => err.code === 'CAPACITY_EXCEEDED',
    );
  });
});

describe('assignBookingToRoom — no-op reassign', () => {
  test('re-assigning to the SAME room does not double-count its paxCount', async (t) => {
    const tag = makeTag('bunk-noop');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 4, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    const room = await tempRoom(t, paket, { kelas: 'QUAD', capacity: 4 });

    await assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: room.id }); // 4/4 full
    // Re-assigning to the same room must NOT throw (own paxCount excluded from current occupancy)
    await assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: room.id });
    const after = await db.booking.findUnique({ where: { id: booking.id }, select: { roomId: true } });
    assert.equal(after.roomId, room.id);
  });
});

describe('unassignBooking', () => {
  test('clears roomId; no-op when already null', async (t) => {
    const tag = makeTag('bunk-unassign');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id });
    const room = await tempRoom(t, paket);

    await assignBookingToRoom({ ...ctx, bookingId: booking.id, roomId: room.id });
    const before = await db.booking.findUnique({ where: { id: booking.id }, select: { roomId: true } });
    assert.equal(before.roomId, room.id);

    await unassignBooking({ ...ctx, bookingId: booking.id });
    const after = await db.booking.findUnique({ where: { id: booking.id }, select: { roomId: true } });
    assert.equal(after.roomId, null);

    // Idempotent — second unassign is a no-op (returns booking unchanged, no audit)
    const auditsBefore = await db.auditLog.count({ where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' } });
    await unassignBooking({ ...ctx, bookingId: booking.id });
    const auditsAfter = await db.auditLog.count({ where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' } });
    assert.equal(auditsAfter, auditsBefore, 'no-op unassign writes no audit');
    t.after(() => db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } }));
  });
});

describe('getBunkingForPaket — math', () => {
  test('null for missing paket', async () => {
    assert.equal(await getBunkingForPaket('no-such-paket'), null);
  });

  test('occupied count = sum of active booking paxCount; CANCELLED ignored', async (t) => {
    const tag = makeTag('bunk-math');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const room = await tempRoom(t, paket, { kelas: 'QUAD', capacity: 4 });

    const bk1 = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 2, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
        roomId: room.id,
      },
    });
    const bk2 = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
        roomId: room.id,
      },
    });
    // Cancelled booking in the same room MUST NOT count
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 4, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
        roomId: room.id,
      },
    });

    const data = await getBunkingForPaket(paket.slug);
    assert.ok(data);
    const r = data.floors[0].rooms.find((x) => x.id === room.id);
    assert.equal(r.occupied, 3, '2 + 1 = 3 (cancelled ignored)');
    assert.equal(r.slotsLeft, 1);
    assert.equal(data.totals.unassignedPax, 0, 'all active bookings assigned');

    // bk1 + bk2 referenced — silence unused-var lint
    void bk1; void bk2;
  });
});
