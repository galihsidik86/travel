// Stage 235 — structured refund reason code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { issueRefund, REFUND_REASON_CODES } from '../src/services/refund.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function cancelledBookingWithPaid(t, tag, paidAmount = '1000000') {
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`,
      paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: paidAmount, paidAmount,
      status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: b.id } });
    await db.booking.deleteMany({ where: { id: b.id } });
  });
  return b;
}

test('REFUND_REASON_CODES: includes expected codes', () => {
  assert.ok(REFUND_REASON_CODES.includes('JEMAAH_REQUEST'));
  assert.ok(REFUND_REASON_CODES.includes('GOODWILL'));
  assert.ok(REFUND_REASON_CODES.includes('VISA_REJECTED'));
  assert.ok(REFUND_REASON_CODES.includes('DUPLICATE_PAYMENT'));
  assert.ok(REFUND_REASON_CODES.includes('OTHER'));
});

test('issueRefund: stores reasonCode on the negative Payment row', async (t) => {
  const tag = makeTag('s235-stored');
  const b = await cancelledBookingWithPaid(t, tag);

  await issueRefund({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, amount: 500_000, method: 'TRANSFER',
    reason: 'visa kuota habis di bulan ini',
    reasonCode: 'VISA_REJECTED',
  });

  const refund = await db.payment.findFirst({
    where: { bookingId: b.id, status: 'REFUNDED' },
  });
  assert.equal(refund.refundReasonCode, 'VISA_REJECTED');
});

test('issueRefund: omitted reasonCode → NULL on Payment row', async (t) => {
  const tag = makeTag('s235-omitted');
  const b = await cancelledBookingWithPaid(t, tag);

  await issueRefund({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, amount: 100_000, method: 'CASH',
    reason: 'partial sebagai goodwill',
  });

  const refund = await db.payment.findFirst({
    where: { bookingId: b.id, status: 'REFUNDED' },
  });
  assert.equal(refund.refundReasonCode, null);
});

test('issueRefund: empty reasonCode → NULL (treats as not picked)', async (t) => {
  const tag = makeTag('s235-empty');
  const b = await cancelledBookingWithPaid(t, tag);

  await issueRefund({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, amount: 100_000, method: 'CASH',
    reason: 'asal alasan tiga karakter',
    reasonCode: '',
  });

  const refund = await db.payment.findFirst({
    where: { bookingId: b.id, status: 'REFUNDED' },
  });
  assert.equal(refund.refundReasonCode, null);
});

test('issueRefund: case-insensitive (lowercase code → uppercase stored)', async (t) => {
  const tag = makeTag('s235-case');
  const b = await cancelledBookingWithPaid(t, tag);

  await issueRefund({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, amount: 100_000, method: 'CASH',
    reason: 'whatever the case',
    reasonCode: 'goodwill',
  });

  const refund = await db.payment.findFirst({
    where: { bookingId: b.id, status: 'REFUNDED' },
  });
  assert.equal(refund.refundReasonCode, 'GOODWILL');
});

test('issueRefund: rejects unknown reasonCode (400)', async (t) => {
  const tag = makeTag('s235-bad');
  const b = await cancelledBookingWithPaid(t, tag);

  await assert.rejects(
    () => issueRefund({
      req: fakeReq, actor: adminActor,
      bookingId: b.id, amount: 100_000, method: 'CASH',
      reason: 'apa pun reasonnya',
      reasonCode: 'NONSENSE',
    }),
    (err) => err.code === 'BAD_REFUND_REASON_CODE' && err.status === 400,
  );
});

test('issueRefund: audit row carries reasonCode in after payload', async (t) => {
  const tag = makeTag('s235-audit');
  const b = await cancelledBookingWithPaid(t, tag);

  await issueRefund({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, amount: 200_000, method: 'TRANSFER',
    reason: 'duplikat transfer',
    reasonCode: 'DUPLICATE_PAYMENT',
  });

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'REFUND_ISSUED' },
    orderBy: { createdAt: 'desc' }, take: 1,
  });
  assert.equal(audits[0].after.refundReasonCode, 'DUPLICATE_PAYMENT');
});
