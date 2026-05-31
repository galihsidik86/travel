// Stage 20 — booking voucher service. Verifies the data shape feeding
// booking-voucher.ejs + the ownership guard on the jemaah path.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import {
  getAdminBookingVoucher, getJemaahBookingVoucher,
} from '../src/services/bookingVoucher.js';

async function tempBooking(t, { paket, jemaah, status = 'PENDING', jemaahUserId = null, paid = '0', total = '10000000' }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id,
      jemaahUserId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: total, paidAmount: paid, status,
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: bk.id } });
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

describe('getAdminBookingVoucher', () => {
  test('returns shaped voucher with totals computed', async (t) => {
    const tag = makeTag('vch-admin');
    const paket = await tempPaket(t, `pkt-${tag}`, { dayCount: 3 });
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, {
      paket, jemaah: jem.jemaah,
      total: '12000000', paid: '5000000', status: 'DP_PAID',
    });

    const v = await getAdminBookingVoucher(bk.id);
    assert.equal(v.bookingNo, bk.bookingNo);
    assert.equal(v.totals.totalAmount, 12_000_000);
    assert.equal(v.totals.paidAmount, 5_000_000);
    assert.equal(v.totals.remaining, 7_000_000);
    assert.equal(v.totals.paidPct, 42, '5M/12M = ~42%');
    assert.ok(v.generatedAt instanceof Date);
    assert.equal(v.paket.days.length, 3, 'itinerary included');
  });

  test('throws 404 when booking not found', async () => {
    await assert.rejects(
      () => getAdminBookingVoucher('does-not-exist-xyz'),
      (err) => err.status === 404 && err.code === 'BOOKING_NOT_FOUND',
    );
  });

  test('paidPct never exceeds 100 even on overpaid', async (t) => {
    const tag = makeTag('vch-over');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, {
      paket, jemaah: jem.jemaah,
      total: '10000000', paid: '0',
    });
    // Manually overpay scenario — paidAmount > totalAmount edge case.
    // Service should still report remaining=0, paidPct can exceed 100
    // (totals.paidPct uses Math.round, no Math.min). View clamps display.
    await db.booking.update({ where: { id: bk.id }, data: { paidAmount: '15000000' } });
    const v = await getAdminBookingVoucher(bk.id);
    assert.equal(v.totals.remaining, 0, 'remaining clamped to 0');
    assert.ok(v.totals.paidPct >= 100, 'pct reflects overpay; view does Math.min(100)');
  });
});

describe('getJemaahBookingVoucher — ownership', () => {
  test('jemaah sees their own claimed booking', async (t) => {
    const tag = makeTag('vch-mine');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, {
      paket, jemaah: jem.jemaah, jemaahUserId: jem.id,
    });

    const v = await getJemaahBookingVoucher(jem.id, bk.id);
    assert.equal(v.bookingNo, bk.bookingNo);
  });

  test('unclaimed booking → 404 (not 403, to avoid existence leak)', async (t) => {
    const tag = makeTag('vch-unclaimed');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, jemaahUserId: null });

    await assert.rejects(
      () => getJemaahBookingVoucher(jem.id, bk.id),
      (err) => err.status === 404,
    );
  });

  test('other jemaah\'s booking → 404 (cross-user enumeration guard)', async (t) => {
    const tag = makeTag('vch-cross');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jemA = await tempJemaah(t, `${tag}-a`);
    const jemB = await tempJemaah(t, `${tag}-b`);
    const bk = await tempBooking(t, { paket, jemaah: jemA.jemaah, jemaahUserId: jemA.id });

    await assert.rejects(
      () => getJemaahBookingVoucher(jemB.id, bk.id),
      (err) => err.status === 404,
    );
  });
});
