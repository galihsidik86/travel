// Stage 323 — getCrewToday now returns inTripAttendance for paket
// currently in-trip with today's attendance progress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempMuthawwif } from './_helpers.js';
import { getCrewToday } from '../src/services/crewToday.js';

async function inTripPaketWithDays(t, tag, { daysAgo = 3 } = {}) {
  const dep = new Date(); dep.setHours(0, 0, 0, 0);
  dep.setDate(dep.getDate() - daysAgo);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
      days: { create: Array.from({ length: 10 }, (_, i) => ({
        dayNumber: i + 1, title: `Day ${i + 1}: itinerary`, description: 'desc',
      })) },
    },
    include: { days: true },
  });
  t.after(async () => {
    await db.attendanceMark.deleteMany({ where: { paketDay: { paketId: paket.id } } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S323 — empty inTripAttendance when crew not assigned to any paket', async (t) => {
  const tag = makeTag('s323a');
  const crew = await tempMuthawwif(t, tag);
  const today = await getCrewToday({ userId: crew.id });
  assert.deepEqual(today.inTripAttendance, []);
});

test('S323 — in-trip paket surfaces with present/total counts', async (t) => {
  const tag = makeTag('s323b');
  const crew = await tempMuthawwif(t, `${tag}-crew`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const paket = await inTripPaketWithDays(t, `${tag}-pkt`, { daysAgo: 3 });

  // Assign crew + create 3 bookings + mark 2 present.
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
  const day4 = paket.days.find((d) => d.dayNumber === 4);
  for (let i = 0; i < 3; i++) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${i}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
      },
    });
    if (i < 2) {
      await db.attendanceMark.create({
        data: { bookingId: b.id, paketDayId: day4.id, present: true, markedByUserId: crew.id, markedAt: new Date() },
      });
    }
  }

  const today = await getCrewToday({ userId: crew.id });
  assert.equal(today.inTripAttendance.length, 1);
  const card = today.inTripAttendance[0];
  assert.equal(card.totalActive, 3);
  assert.equal(card.presentCount, 2);
  assert.equal(card.unmarkedCount, 1);
  assert.equal(card.percentPresent, 67);
  assert.equal(card.day.dayNumber, 4);
});

test('S323 — does NOT surface pre-trip / post-trip paket', async (t) => {
  const tag = makeTag('s323c');
  const crew = await tempMuthawwif(t, `${tag}-crew`);
  // Future paket: dep = today + 10
  const dep = new Date(); dep.setDate(dep.getDate() + 10);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-pkt`, title: 'Future paket',
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
      days: { create: [{ dayNumber: 1, title: 'D1', description: 'd1' }] },
    },
  });
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  const today = await getCrewToday({ userId: crew.id });
  assert.deepEqual(today.inTripAttendance, []);
});
