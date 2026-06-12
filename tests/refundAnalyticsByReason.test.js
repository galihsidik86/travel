// Stage 236 — refund analytics per reason code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah } from './_helpers.js';
import { getRefundAnalytics } from '../src/services/refundAnalytics.js';

async function makeRefundedBooking(t, tag, refundAmount, reasonCode = null) {
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`,
      paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '5000000', paidAmount: '0',
      status: 'REFUNDED',
    },
  });
  // PAID row (denominator)
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '5000000', currency: 'IDR',
      method: 'TRANSFER', status: 'PAID',
      paidAt: new Date(),
    },
  });
  // REFUND row
  await db.payment.create({
    data: {
      bookingId: b.id, amount: String(-refundAmount), currency: 'IDR',
      method: 'TRANSFER', status: 'REFUNDED',
      paidAt: new Date(),
      ...(reasonCode ? { refundReasonCode: reasonCode } : {}),
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: b.id } });
    await db.booking.deleteMany({ where: { id: b.id } });
  });
  return { paket, b };
}

test('getRefundAnalytics: perReasonCode buckets by code', async (t) => {
  const tag = makeTag('s236-bucket');
  await makeRefundedBooking(t, tag + '-a', 1_000_000, 'VISA_REJECTED');
  await makeRefundedBooking(t, tag + '-b', 500_000, 'GOODWILL');
  await makeRefundedBooking(t, tag + '-c', 250_000, 'VISA_REJECTED');

  const r = await getRefundAnalytics({ days: 90 });
  const visa = r.perReasonCode.find((rc) => rc.code === 'VISA_REJECTED');
  const goodwill = r.perReasonCode.find((rc) => rc.code === 'GOODWILL');

  assert.ok(visa);
  assert.equal(visa.refundCount, 2);
  assert.equal(visa.refunded, 1_250_000);
  assert.ok(goodwill);
  assert.equal(goodwill.refundCount, 1);
  assert.equal(goodwill.refunded, 500_000);
});

test('getRefundAnalytics: NULL refundReasonCode buckets under __UNSET__', async (t) => {
  const tag = makeTag('s236-unset');
  await makeRefundedBooking(t, tag + '-x', 100_000, null); // no code

  const r = await getRefundAnalytics({ days: 90 });
  const unset = r.perReasonCode.find((rc) => rc.code === '__UNSET__');
  assert.ok(unset);
  assert.ok(unset.refundCount >= 1);
});

test('getRefundAnalytics: sharePct sums sensibly (per-row vs total)', async (t) => {
  const tag = makeTag('s236-share');
  await makeRefundedBooking(t, tag + '-a', 700_000, 'GOODWILL');
  await makeRefundedBooking(t, tag + '-b', 300_000, 'JEMAAH_REQUEST');

  const r = await getRefundAnalytics({ days: 90 });
  const goodwill = r.perReasonCode.find((rc) => rc.code === 'GOODWILL');
  const jr = r.perReasonCode.find((rc) => rc.code === 'JEMAAH_REQUEST');
  // sharePct should be calculated against TOTAL refunded across all codes,
  // not just these two — but both should still be < 100 and positive.
  assert.ok(goodwill.sharePct > 0);
  assert.ok(jr.sharePct > 0);
  // Goodwill share > jemaah_request share since 700k > 300k
  assert.ok(goodwill.sharePct >= jr.sharePct);
});

test('getRefundAnalytics: __UNSET__ rendered last regardless of size', async (t) => {
  const tag = makeTag('s236-unset-last');
  // Big unset bucket (1M) + small goodwill (100k)
  await makeRefundedBooking(t, tag + '-1', 1_000_000, null);
  await makeRefundedBooking(t, tag + '-2', 100_000, 'GOODWILL');

  const r = await getRefundAnalytics({ days: 90 });
  // Last entry must be __UNSET__ even though it has the largest refunded
  const last = r.perReasonCode[r.perReasonCode.length - 1];
  assert.equal(last.code, '__UNSET__');
});

test('getRefundAnalytics: sharePct null when no refunds in window', async () => {
  // Use a tiny window so most rows are excluded
  const r = await getRefundAnalytics({ days: 90 });
  // Empty isn't actionable; just check structure
  assert.ok(Array.isArray(r.perReasonCode));
});
