// Stage 237 — auto-cancel stale unpaid PENDING bookings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import {
  getStalePendingCandidates,
  runAutoCancelStalePending,
  DEFAULT_STALE_DAYS,
} from '../src/services/autoCancelStalePending.js';

async function makePaket(t, tag, { daysOut = 30, status = 'ACTIVE' } = {}) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0, status,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function makePendingBooking({ paket, jemaahId, createdDaysAgo = 0, paidAmount = '0' }) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount,
      status: 'PENDING',
      createdAt: new Date(Date.now() - createdDaysAgo * 86_400_000),
    },
  });
}

test('DEFAULT_STALE_DAYS exposed', () => {
  assert.equal(DEFAULT_STALE_DAYS, 14);
});

test('getStalePendingCandidates: surfaces PENDING+unpaid older than cutoff', async (t) => {
  const tag = makeTag('s237-stale');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.ok(mine, 'old PENDING surfaces');
});

test('getStalePendingCandidates: skips PENDING with partial payment', async (t) => {
  const tag = makeTag('s237-partial');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({
    paket, jemaahId: u.jemaah.id, createdDaysAgo: 20, paidAmount: '100000',
  });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.equal(mine, undefined);
});

test('getStalePendingCandidates: skips PENDING newer than cutoff', async (t) => {
  const tag = makeTag('s237-young');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 5 });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.equal(mine, undefined);
});

test('getStalePendingCandidates: skips non-PENDING bookings (BOOKED/LUNAS/etc.)', async (t) => {
  const tag = makeTag('s237-nonpending');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });
  await db.booking.update({ where: { id: b.id }, data: { status: 'BOOKED' } });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.equal(mine, undefined);
});

test('getStalePendingCandidates: skips ARCHIVED paket', async (t) => {
  const tag = makeTag('s237-archived');
  const paket = await makePaket(t, tag, { status: 'ARCHIVED' });
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.equal(mine, undefined);
});

test('getStalePendingCandidates: skips paket already departed', async (t) => {
  const tag = makeTag('s237-past');
  const paket = await makePaket(t, tag, { daysOut: -10 }); // already left
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });

  const candidates = await getStalePendingCandidates({ staleDays: 14 });
  const mine = candidates.find((c) => c.id === b.id);
  assert.equal(mine, undefined);
});

test('runAutoCancelStalePending: flips PENDING → CANCELLED with reasonCode', async (t) => {
  const tag = makeTag('s237-run');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });
  // cancelBooking decrements kursiTerisi — bump it first so we don't end up negative
  await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 1 } });

  const r = await runAutoCancelStalePending({ staleDays: 14 });
  assert.ok(r.cancelled >= 1);

  const after = await db.booking.findUnique({
    where: { id: b.id },
    select: { status: true, cancelReasonCode: true, cancelReason: true },
  });
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.cancelReasonCode, 'PAYMENT_NOT_RECEIVED');
  assert.match(after.cancelReason, /Auto-cancel/);
});

test('runAutoCancelStalePending: silent on quiet days', async () => {
  // No fixtures — fresh runs on the existing DB shouldn't error out
  const r = await runAutoCancelStalePending({ staleDays: 999 });
  // 999-day threshold means nothing should be eligible (test DB has only fresh data)
  assert.equal(r.cancelled, 0);
  assert.ok(r.candidates >= 0);
});

test('runAutoCancelStalePending: per-row failure caught (batch continues)', async (t) => {
  const tag = makeTag('s237-batch');
  const paket = await makePaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Two stale bookings — verify both attempt
  await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 20 });
  await makePendingBooking({ paket, jemaahId: u.jemaah.id, createdDaysAgo: 25 });
  await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 2 } });

  const r = await runAutoCancelStalePending({ staleDays: 14 });
  assert.ok(r.candidates >= 2);
  assert.ok(r.cancelled >= 2);
});
