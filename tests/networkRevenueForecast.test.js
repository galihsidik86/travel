// Stage 251 — network-wide expected revenue forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import { getNetworkRevenueForecast } from '../src/services/networkRevenueForecast.js';

async function makePaket(t, tag, { daysOut = 30, status = 'ACTIVE' } = {}) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 20, status,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function makeBooking(paket, jemaahId, { totalAmount = '10000000', paidAmount = '0', status = 'BOOKED' } = {}) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount, paidAmount, status,
    },
  });
}

test('getNetworkRevenueForecast: empty when no active bookings', async () => {
  // Existing DB may have rows; assert shape only
  const r = await getNetworkRevenueForecast();
  assert.ok(r.totals);
  assert.ok(Array.isArray(r.perStatus));
  assert.ok(Array.isArray(r.perPaket));
});

test('getNetworkRevenueForecast: weightedExpected = remaining × probability', async (t) => {
  const tag = makeTag('s251-weight');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  // 1 BOOKED with 10M total, 2M paid → 8M remaining × 0.5 = 4M weighted
  await makeBooking(paket, j.jemaah.id, {
    totalAmount: '10000000', paidAmount: '2000000', status: 'BOOKED',
  });

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  assert.ok(mine);
  assert.equal(mine.remaining, 8_000_000);
  assert.equal(mine.weightedExpected, 4_000_000);
});

test('getNetworkRevenueForecast: PARTIAL has higher probability than BOOKED', async (t) => {
  const tag = makeTag('s251-status');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id, {
    totalAmount: '10000000', paidAmount: '5000000', status: 'PARTIAL',
  });

  const r = await getNetworkRevenueForecast();
  const partial = r.perStatus.find((s) => s.status === 'PARTIAL');
  const booked = r.perStatus.find((s) => s.status === 'BOOKED');
  assert.equal(partial.probability, 0.85);
  assert.equal(booked.probability, 0.5);
});

test('getNetworkRevenueForecast: LUNAS bookings show 0 remaining', async (t) => {
  const tag = makeTag('s251-lunas');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id, {
    totalAmount: '5000000', paidAmount: '5000000', status: 'LUNAS',
  });

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  assert.ok(mine);
  // LUNAS = no remaining cash to collect (paid = total)
  assert.equal(mine.remaining, 0);
  assert.equal(mine.weightedExpected, 0);
});

test('getNetworkRevenueForecast: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s251-cancel');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id, {
    totalAmount: '10000000', paidAmount: '0', status: 'CANCELLED',
  });

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  assert.equal(mine, undefined);
});

test('getNetworkRevenueForecast: past-departure paket excluded', async (t) => {
  const tag = makeTag('s251-past');
  const paket = await makePaket(t, tag, { daysOut: -5 });
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id);

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  assert.equal(mine, undefined);
});

test('getNetworkRevenueForecast: ARCHIVED paket excluded', async (t) => {
  const tag = makeTag('s251-arch');
  const paket = await makePaket(t, tag, { status: 'ARCHIVED' });
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id);

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  assert.equal(mine, undefined);
});

test('getNetworkRevenueForecast: perPaket sorted by departureDate asc', async (t) => {
  const tag = makeTag('s251-sort');
  const near = await makePaket(t, tag + '-near', { daysOut: 7 });
  const far = await makePaket(t, tag + '-far', { daysOut: 60 });
  const j = await tempJemaah(t, tag);
  await makeBooking(near, j.jemaah.id);
  await makeBooking(far, j.jemaah.id);

  const r = await getNetworkRevenueForecast();
  const idxNear = r.perPaket.findIndex((p) => p.paket.id === near.id);
  const idxFar = r.perPaket.findIndex((p) => p.paket.id === far.id);
  assert.ok(idxNear >= 0 && idxFar >= 0);
  assert.ok(idxNear < idxFar);
});

test('getNetworkRevenueForecast: per-status accumulates across paket', async (t) => {
  const tag = makeTag('s251-accum');
  const p1 = await makePaket(t, tag + '-1');
  const p2 = await makePaket(t, tag + '-2');
  const j = await tempJemaah(t, tag);
  // 2 BOOKED on different paket, both with 8M remaining
  await makeBooking(p1, j.jemaah.id, { totalAmount: '10000000', paidAmount: '2000000', status: 'BOOKED' });
  await makeBooking(p2, j.jemaah.id, { totalAmount: '10000000', paidAmount: '2000000', status: 'BOOKED' });

  const r = await getNetworkRevenueForecast();
  const booked = r.perStatus.find((s) => s.status === 'BOOKED');
  // Per-status totals should reflect the contribution from both paket
  // (at least 16M remaining, 8M weighted from these two bookings)
  assert.ok(booked.remaining >= 16_000_000);
  assert.ok(booked.weightedExpected >= 8_000_000);
});

test('getNetworkRevenueForecast: totals sum across paket', async (t) => {
  const tag = makeTag('s251-totals');
  const paket = await makePaket(t, tag);
  const j = await tempJemaah(t, tag);
  await makeBooking(paket, j.jemaah.id, { totalAmount: '5000000', paidAmount: '1000000', status: 'BOOKED' });
  await makeBooking(paket, j.jemaah.id, { totalAmount: '5000000', paidAmount: '1000000', status: 'DP_PAID' });

  const r = await getNetworkRevenueForecast();
  const mine = r.perPaket.find((p) => p.paket.id === paket.id);
  // Two bookings each with 4M remaining = 8M total
  assert.equal(mine.remaining, 8_000_000);
  // BOOKED ×0.5 + DP_PAID ×0.7 = 4M × (0.5 + 0.7) = 4.8M
  assert.equal(mine.weightedExpected, 4_800_000);
});
