// Stage 320 — getInTripContext returns Day N/total + today's itinerary
// only when jemaah is currently in-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah } from './_helpers.js';
import { getInTripContext } from '../src/services/jemaahPortal.js';

async function paketWindowAroundToday(t, tag, { daysAgo = 3, durationDays = 10 } = {}) {
  const dep = new Date();
  dep.setHours(0, 0, 0, 0);
  dep.setDate(dep.getDate() - daysAgo);
  const ret = new Date(dep.getTime() + (durationDays - 1) * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
      days: {
        create: Array.from({ length: durationDays }, (_, i) => ({
          dayNumber: i + 1, title: `Day ${i + 1}: itinerary`, description: 'desc',
        })),
      },
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S320 — returns null when jemaah has no bookings', async (t) => {
  const tag = makeTag('s320a');
  const jem = await tempJemaah(t, tag);
  const ctx = await getInTripContext(jem.id);
  assert.equal(ctx, null);
});

test('S320 — returns null when LUNAS booking is pre-trip', async (t) => {
  const tag = makeTag('s320b');
  const jem = await tempJemaah(t, `${tag}-j`);
  // Future-dated paket: dep = today + 10
  const dep = new Date(); dep.setDate(dep.getDate() + 10);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `${tag}-pkt`, title: 'Future paket',
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const ctx = await getInTripContext(jem.id);
  assert.equal(ctx, null);
});

test('S320 — picks up in-trip booking + computes Day N + attaches itinerary', async (t) => {
  const tag = makeTag('s320c');
  const jem = await tempJemaah(t, `${tag}-j`);
  // departureDate = 3 days ago, returnDate = 6 days from now (10-day paket).
  const paket = await paketWindowAroundToday(t, `${tag}-pkt`, { daysAgo: 3, durationDays: 10 });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const ctx = await getInTripContext(jem.id);
  assert.ok(ctx, 'context returned');
  assert.equal(ctx.dayN, 4, 'day 4 of 10 (depart=Day 1, +3 days = Day 4)');
  assert.equal(ctx.total, 10);
  assert.ok(ctx.todayItinerary, 'today itinerary attached');
  assert.match(ctx.todayItinerary.title, /Day 4/);
  assert.ok(ctx.nextItinerary, 'next-day itinerary attached');
  assert.match(ctx.nextItinerary.title, /Day 5/);
});

test('S320 — ignores non-LUNAS bookings even when in window', async (t) => {
  const tag = makeTag('s320d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketWindowAroundToday(t, `${tag}-pkt`);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '500000', status: 'DP_PAID',
    },
  });
  const ctx = await getInTripContext(jem.id);
  assert.equal(ctx, null);
});

test('S320 — last day of trip still counts as in-trip', async (t) => {
  const tag = makeTag('s320e');
  const jem = await tempJemaah(t, `${tag}-j`);
  // depart 9 days ago, return today (10-day paket: Day 1..10, today=Day 10)
  const paket = await paketWindowAroundToday(t, `${tag}-pkt`, { daysAgo: 9, durationDays: 10 });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const ctx = await getInTripContext(jem.id);
  assert.ok(ctx, 'context returned on return-date day');
  assert.equal(ctx.dayN, 10);
});
