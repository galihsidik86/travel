// Stage 322 — getMyBooking now includes paket.days for the itinerary
// timeline view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah } from './_helpers.js';
import { getMyBooking } from '../src/services/jemaahPortal.js';

test('S322 — getMyBooking returns paket.days for itinerary timeline', async (t) => {
  const tag = makeTag('s322a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-pkt`, title: 'Test paket',
      departureDate: dep, returnDate: new Date(dep.getTime() + 9 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
      days: { create: [
        { dayNumber: 1, title: 'Day 1: Madinah', description: 'Arrival + check-in' },
        { dayNumber: 2, title: 'Day 2: Masjid Nabawi', description: 'Ziarah' },
        { dayNumber: 3, title: 'Day 3: Quba', description: 'Masjid Quba visit' },
      ] },
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const got = await getMyBooking(jem.id, b.id);
  assert.ok(got);
  assert.ok(Array.isArray(got.paket.days));
  assert.equal(got.paket.days.length, 3);
  // Ordered by dayNumber asc
  assert.equal(got.paket.days[0].dayNumber, 1);
  assert.equal(got.paket.days[0].title, 'Day 1: Madinah');
  assert.equal(got.paket.days[2].dayNumber, 3);
});

test('S322 — cross-user booking access returns null', async (t) => {
  const tag = makeTag('s322b');
  const owner = await tempJemaah(t, `${tag}-owner`);
  const stranger = await tempJemaah(t, `${tag}-stranger`);
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-pkt`, title: 'Test',
      departureDate: dep, returnDate: new Date(dep.getTime() + 9 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: owner.jemaah.id, jemaahUserId: owner.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const got = await getMyBooking(stranger.id, b.id);
  assert.equal(got, null);
});
