// Paket admin nested CRUD: hotels + days + rooms. Each service has the
// loadPaketBySlug + loadOwned<thing> ownership guard pattern — covered
// here so a regression on slug mismatch / wrong-paket cross-ref shows up.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import {
  addHotel, updateHotel, deleteHotel,
  addDay, updateDay, deleteDay,
  addRoom, updateRoom, deleteRoom,
} from '../src/services/paketAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

describe('Hotels', () => {
  test('addHotel → updateHotel → deleteHotel roundtrip', async (t) => {
    const tag = makeTag('hotel-rt');
    const paket = await tempPaket(t, tag);

    const created = await addHotel({
      ...ctx, paketSlug: paket.slug,
      input: { city: 'MADINAH', name: 'Pullman Madinah', stars: 5, nights: 4, order: 0 },
    });
    assert.equal(created.city, 'MADINAH');
    assert.equal(created.name, 'Pullman Madinah');

    const updated = await updateHotel({
      ...ctx, paketSlug: paket.slug, hotelId: created.id,
      input: { city: 'MADINAH', name: 'Pullman Madinah Renamed', stars: 5, nights: 5, order: 0 },
    });
    assert.equal(updated.name, 'Pullman Madinah Renamed');
    assert.equal(updated.nights, 5);

    await deleteHotel({ ...ctx, paketSlug: paket.slug, hotelId: created.id });
    const gone = await db.paketHotel.findUnique({ where: { id: created.id } });
    assert.equal(gone, null);
  });

  test('PAKET_NOT_FOUND for unknown slug', async () => {
    await assert.rejects(
      addHotel({
        ...ctx, paketSlug: 'no-such-paket',
        input: { city: 'MEKKAH', name: 'X', stars: 5, nights: 3, order: 0 },
      }),
      (err) => err.code === 'PAKET_NOT_FOUND',
    );
  });

  test('HOTEL_NOT_FOUND when hotelId belongs to a different paket', async (t) => {
    const tag = makeTag('hotel-cross');
    const paketA = await tempPaket(t, `${tag}-a`);
    const paketB = await tempPaket(t, `${tag}-b`);
    const hotelOnB = await addHotel({
      ...ctx, paketSlug: paketB.slug,
      input: { city: 'MEKKAH', name: 'Pullman Zamzam', stars: 5, nights: 4, order: 0 },
    });

    // Try to update B's hotel using A's slug — ownership guard fires
    await assert.rejects(
      updateHotel({
        ...ctx, paketSlug: paketA.slug, hotelId: hotelOnB.id,
        input: { city: 'MEKKAH', name: 'Hijacked', stars: 5, nights: 4, order: 0 },
      }),
      (err) => err.code === 'HOTEL_NOT_FOUND' || err.code === 'FORBIDDEN',
    );
  });
});

describe('Days', () => {
  test('addDay sequenced by dayNumber, updateDay edits title', async (t) => {
    const tag = makeTag('day-rt');
    const paket = await tempPaket(t, tag);

    const d1 = await addDay({
      ...ctx, paketSlug: paket.slug,
      input: { dayNumber: 1, title: 'Arrival', description: 'Land Madinah' },
    });
    const d2 = await addDay({
      ...ctx, paketSlug: paket.slug,
      input: { dayNumber: 2, title: 'Manasik', description: 'Practice' },
    });
    assert.ok(d1.id !== d2.id);
    assert.equal(d2.dayNumber, 2);

    const updated = await updateDay({
      ...ctx, paketSlug: paket.slug, dayId: d2.id,
      input: { dayNumber: 2, title: 'Manasik Lengkap', description: 'Practice + tawaf' },
    });
    assert.equal(updated.title, 'Manasik Lengkap');

    await deleteDay({ ...ctx, paketSlug: paket.slug, dayId: d1.id });
    const leftover = await db.paketDay.findMany({
      where: { paketId: paket.id }, orderBy: { dayNumber: 'asc' },
    });
    assert.equal(leftover.length, 1);
    assert.equal(leftover[0].id, d2.id);
  });
});

describe('Rooms', () => {
  test('addRoom uses kelas default capacity (QUAD=4)', async (t) => {
    const tag = makeTag('room-default');
    const paket = await tempPaket(t, tag);

    const room = await addRoom({
      ...ctx, paketSlug: paket.slug,
      input: { roomNo: `Q-${tag}`, kelas: 'QUAD', floor: 4, wing: 'Selatan' },
      // capacity intentionally omitted
    });
    assert.equal(room.kelas, 'QUAD');
    // Capacity should default to 4 for QUAD per CLAUDE.md invariant
    assert.equal(room.capacity, 4);
  });

  test('addRoom honours explicit capacity override', async (t) => {
    const tag = makeTag('room-cap');
    const paket = await tempPaket(t, tag);

    const room = await addRoom({
      ...ctx, paketSlug: paket.slug,
      input: { roomNo: `OVR-${tag}`, kelas: 'QUAD', capacity: 3, floor: 5 },
    });
    assert.equal(room.capacity, 3, 'override respected');
  });

  test('addRoom rejects duplicate (paketId, roomNo) with ROOM_NO_TAKEN', async (t) => {
    const tag = makeTag('room-dupe');
    const paket = await tempPaket(t, tag);

    const roomNo = `DUP-${tag}`;
    await addRoom({
      ...ctx, paketSlug: paket.slug,
      input: { roomNo, kelas: 'QUAD', floor: 1 },
    });
    // Service catches the @unique clash + rethrows as a friendly 409 with code
    await assert.rejects(
      addRoom({
        ...ctx, paketSlug: paket.slug,
        input: { roomNo, kelas: 'QUAD', floor: 1 },
      }),
      (err) => err.code === 'ROOM_NO_TAKEN' && err.status === 409,
    );
  });

  test('updateRoom + deleteRoom respect ownership', async (t) => {
    const tag = makeTag('room-own');
    const paketA = await tempPaket(t, `${tag}-a`);
    const paketB = await tempPaket(t, `${tag}-b`);
    const roomOnB = await addRoom({
      ...ctx, paketSlug: paketB.slug,
      input: { roomNo: `B-${tag}`, kelas: 'DOUBLE', floor: 5 },
    });

    // Cross-paket update — guard refuses
    await assert.rejects(
      updateRoom({
        ...ctx, paketSlug: paketA.slug, roomId: roomOnB.id,
        input: { roomNo: `B-${tag}`, kelas: 'DOUBLE', floor: 5 },
      }),
      (err) => err.code === 'ROOM_NOT_FOUND' || err.code === 'FORBIDDEN',
    );

    // Cross-paket delete — also refuses
    await assert.rejects(
      deleteRoom({ ...ctx, paketSlug: paketA.slug, roomId: roomOnB.id }),
      (err) => err.code === 'ROOM_NOT_FOUND' || err.code === 'FORBIDDEN',
    );

    // Owner-side delete works
    await deleteRoom({ ...ctx, paketSlug: paketB.slug, roomId: roomOnB.id });
    const gone = await db.room.findUnique({ where: { id: roomOnB.id } });
    assert.equal(gone, null);
  });
});
