// Stage 32 — per-paket 7-day recap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { getPaketWeeklyRecap } from '../src/services/paketWeeklyRecap.js';

const ONE_DAY_MS = 86_400_000;

test('returns null for unknown slug + soft-deleted paket', async (t) => {
  assert.equal(await getPaketWeeklyRecap({ slug: 'definitely-does-not-exist-xyz' }), null);
  const tag = makeTag('recap-deleted');
  const paket = await tempPaket(t, tag);
  await db.paket.update({ where: { id: paket.id }, data: { deletedAt: new Date() } });
  assert.equal(await getPaketWeeklyRecap({ slug: paket.slug }), null);
});

test('counts new bookings inside the rolling 7-day window', async (t) => {
  const tag = makeTag('recap-count');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const now = new Date();
  // 3 inside the window (3 days ago)
  for (let i = 0; i < 3; i++) {
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: { createdAt: new Date(now.getTime() - 3 * ONE_DAY_MS + i * 1000) },
    });
  }
  // 1 outside (8 days ago — too old)
  const old = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: old.id },
    data: { createdAt: new Date(now.getTime() - 8 * ONE_DAY_MS) },
  });

  const recap = await getPaketWeeklyRecap({ slug: paket.slug });
  assert.equal(recap.counts.newBookings, 3);
  assert.equal(recap.window.days, 7);
  assert.equal(recap.recentNewBookings.length, 3);
});

test('payments IDR-only, refunds aggregated separately', async (t) => {
  const tag = makeTag('recap-money');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, totalAmount: '5000000',
  });
  const inWindow = new Date(Date.now() - 2 * ONE_DAY_MS);

  const idr = await db.payment.create({
    data: {
      bookingId: booking.id, method: 'CASH', amount: '2000000', currency: 'IDR',
      status: 'PAID', paidAt: inWindow,
    },
  });
  const usd = await db.payment.create({
    data: {
      bookingId: booking.id, method: 'CASH', amount: '100', currency: 'USD',
      amountIdrEq: '1500000', exchangeRate: '15000', status: 'PAID',
      paidAt: inWindow,
    },
  });
  const ref = await db.payment.create({
    data: {
      bookingId: booking.id, method: 'CASH', amount: '-500000', currency: 'IDR',
      status: 'REFUNDED', createdAt: inWindow,
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { id: { in: [idr.id, usd.id, ref.id] } } });
  });

  const recap = await getPaketWeeklyRecap({ slug: paket.slug });
  assert.equal(recap.money.paymentsInIdr, 2_000_000, 'USD must NOT be included in paymentsInIdr');
  assert.equal(recap.money.refundsOutIdr, 500_000);
  assert.equal(recap.money.netRevenueIdr, 1_500_000);
});

test('window edge: bookings created exactly at start-of-window included; before excluded', async (t) => {
  const tag = makeTag('recap-edge');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // The service window: end = today 00:00, start = end - 7d
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * ONE_DAY_MS);

  const atEdge = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: atEdge.id },
    data: { createdAt: new Date(start.getTime() + 1000) }, // just inside
  });
  const before = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({
    where: { id: before.id },
    data: { createdAt: new Date(start.getTime() - 1000) }, // just outside
  });

  const recap = await getPaketWeeklyRecap({ slug: paket.slug });
  const ids = recap.recentNewBookings.map((b) => b.id);
  assert.ok(ids.includes(atEdge.id), 'at-edge booking must be inside the window');
  assert.ok(!ids.includes(before.id), 'before-edge booking must be outside');
});
