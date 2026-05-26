// Refund flow tests (5m). issueRefund is strict: cancel first, refund after.
// Verifies append-only Payment rows (negative amount, REFUNDED status),
// partial refunds repeatable until paidAmount=0 → status flips to REFUNDED.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { recordPayment } from '../src/services/payment.js';
import { issueRefund } from '../src/services/refund.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

async function setupCancelledWithPayment(t, tag, paidAmount = 1_000_000) {
  const user = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id, totalAmount: '1000000',
  });
  await recordPayment({
    ...ctx, bookingId: booking.id, amount: paidAmount, method: 'TRANSFER',
  });
  await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'test cancellation' });
  return { user, paket, booking };
}

describe('issueRefund — validation', () => {
  test('refuses non-CANCELLED booking', async (t) => {
    const tag = makeTag('refund-active');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    await recordPayment({ ...ctx, bookingId: booking.id, amount: 500_000, method: 'TRANSFER' });
    // booking is now DP_PAID, not CANCELLED — refund must refuse

    await assert.rejects(
      issueRefund({
        ...ctx, bookingId: booking.id, amount: 100_000, method: 'TRANSFER', reason: 'test',
      }),
      (err) => err.code === 'BOOKING_NOT_CANCELLED',
    );
  });

  test('refuses invalid method', async (t) => {
    const tag = makeTag('refund-method');
    const { booking } = await setupCancelledWithPayment(t, tag);
    await assert.rejects(
      issueRefund({ ...ctx, bookingId: booking.id, amount: 100_000, method: 'BITCOIN', reason: 'test' }),
      (err) => err.code === 'INVALID_METHOD',
    );
  });

  test('refuses reason shorter than 3 chars', async (t) => {
    const tag = makeTag('refund-reason');
    const { booking } = await setupCancelledWithPayment(t, tag);
    await assert.rejects(
      issueRefund({ ...ctx, bookingId: booking.id, amount: 100_000, method: 'TRANSFER', reason: 'no' }),
      (err) => err.code === 'REFUND_REASON_REQUIRED',
    );
  });

  test('refuses amount <= 0', async (t) => {
    const tag = makeTag('refund-zero');
    const { booking } = await setupCancelledWithPayment(t, tag);
    await assert.rejects(
      issueRefund({ ...ctx, bookingId: booking.id, amount: 0, method: 'TRANSFER', reason: 'test' }),
      (err) => err.code === 'INVALID_AMOUNT',
    );
  });

  test('refuses amount exceeding paidAmount', async (t) => {
    const tag = makeTag('refund-overflow');
    const { booking } = await setupCancelledWithPayment(t, tag, 500_000);
    await assert.rejects(
      issueRefund({
        ...ctx, bookingId: booking.id, amount: 600_000, method: 'TRANSFER', reason: 'test',
      }),
      (err) => err.code === 'REFUND_EXCEEDS_PAID',
    );
  });

  test('refuses when paidAmount = 0 (nothing to refund)', async (t) => {
    const tag = makeTag('refund-nothing');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    // Cancel WITHOUT any payment first
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'never paid' });
    await assert.rejects(
      issueRefund({ ...ctx, bookingId: booking.id, amount: 1, method: 'TRANSFER', reason: 'test' }),
      (err) => err.code === 'NOTHING_TO_REFUND',
    );
  });
});

describe('issueRefund — append-only Payment row', () => {
  test('full refund creates negative Payment row, REFUNDED status; booking → REFUNDED', async (t) => {
    const tag = makeTag('refund-full');
    const { booking } = await setupCancelledWithPayment(t, tag, 1_000_000);

    const { payment, booking: after } = await issueRefund({
      ...ctx, bookingId: booking.id, amount: 1_000_000, method: 'TRANSFER',
      reason: 'full refund per ops',
    });

    // Payment row is append-only — NEW row, not mutation of the original
    assert.equal(payment.status, 'REFUNDED');
    assert.equal(Number(payment.amount), -1_000_000, 'amount stored negative');
    assert.equal(Number(after.paidAmount), 0, 'paidAmount drained');
    assert.equal(after.status, 'REFUNDED', 'booking transitions terminal');

    // Original PAID row still exists untouched
    const allPayments = await db.payment.findMany({
      where: { bookingId: booking.id }, orderBy: { createdAt: 'asc' },
    });
    assert.equal(allPayments.length, 2, 'PAID + REFUNDED = 2 rows');
    assert.equal(allPayments[0].status, 'PAID');
    assert.equal(Number(allPayments[0].amount), 1_000_000);
  });

  test('partial refunds are repeatable; booking stays CANCELLED until paidAmount=0', async (t) => {
    const tag = makeTag('refund-partial');
    const { booking } = await setupCancelledWithPayment(t, tag, 1_000_000);

    const r1 = await issueRefund({
      ...ctx, bookingId: booking.id, amount: 300_000, method: 'TRANSFER', reason: 'partial 1',
    });
    assert.equal(Number(r1.booking.paidAmount), 700_000);
    assert.equal(r1.booking.status, 'CANCELLED', 'partial keeps CANCELLED');

    const r2 = await issueRefund({
      ...ctx, bookingId: booking.id, amount: 400_000, method: 'TRANSFER', reason: 'partial 2',
    });
    assert.equal(Number(r2.booking.paidAmount), 300_000);
    assert.equal(r2.booking.status, 'CANCELLED');

    // Final refund drains to 0 → REFUNDED terminal
    const r3 = await issueRefund({
      ...ctx, bookingId: booking.id, amount: 300_000, method: 'TRANSFER', reason: 'final',
    });
    assert.equal(Number(r3.booking.paidAmount), 0);
    assert.equal(r3.booking.status, 'REFUNDED');

    // After full drain, booking is now REFUNDED (terminal). Refund refuses because
    // status check fires before paidAmount check.
    await assert.rejects(
      issueRefund({ ...ctx, bookingId: booking.id, amount: 1, method: 'TRANSFER', reason: 'oops' }),
      (err) => err.code === 'BOOKING_NOT_CANCELLED',
    );

    // 4 Payment rows: 1 PAID + 3 REFUNDED
    const all = await db.payment.findMany({ where: { bookingId: booking.id } });
    assert.equal(all.length, 4);
    const refunded = all.filter((p) => p.status === 'REFUNDED');
    assert.equal(refunded.length, 3);
    const refundSum = refunded.reduce((s, p) => s + Number(p.amount), 0);
    assert.equal(refundSum, -1_000_000, 'refund amounts sum to -1M');
  });
});
