// Stage 295 + 296 — booking adjustment (discount/surcharge) service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  addBookingAdjustment,
  removeBookingAdjustment,
  listBookingAdjustments,
  ADJUSTMENT_REASON_CODES,
} from '../src/services/bookingAdjustments.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function setup(t, tag, opts = {}) {
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const b = await tempBooking({
    paket, jemaahProfileId: jemaah.jemaah.id,
    totalAmount: opts.totalAmount || '10000000',
  });
  if (opts.paidAmount) {
    await db.booking.update({ where: { id: b.id }, data: { paidAmount: opts.paidAmount } });
  }
  return { paket, jemaah, booking: b };
}

// ── reason allowlist sanity ────────────────────────────────────

test('ADJUSTMENT_REASON_CODES: includes expected codes', () => {
  assert.ok(ADJUSTMENT_REASON_CODES.includes('LOYALTY'));
  assert.ok(ADJUSTMENT_REASON_CODES.includes('PROMO'));
  assert.ok(ADJUSTMENT_REASON_CODES.includes('GOODWILL'));
  assert.ok(ADJUSTMENT_REASON_CODES.includes('CORRECTION'));
  assert.ok(ADJUSTMENT_REASON_CODES.includes('OTHER'));
});

// ── validation ─────────────────────────────────────────────────

test('addBookingAdjustment: 400 on missing bookingId', async () => {
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: '', kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'PROMO',
    }),
    (err) => err.code === 'BOOKING_ID_REQUIRED' && err.status === 400,
  );
});

test('addBookingAdjustment: 400 on bad kind', async (t) => {
  const { booking } = await setup(t, 'adj-kind');
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'REFUND', amountIdr: 100000, reasonCode: 'PROMO',
    }),
    (err) => err.code === 'ADJUSTMENT_BAD_KIND' && err.status === 400,
  );
});

test('addBookingAdjustment: 400 on zero/negative amount', async (t) => {
  const { booking } = await setup(t, 'adj-amt');
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 0, reasonCode: 'PROMO',
    }),
    (err) => err.code === 'ADJUSTMENT_BAD_AMOUNT',
  );
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'DISCOUNT', amountIdr: -1000, reasonCode: 'PROMO',
    }),
    (err) => err.code === 'ADJUSTMENT_BAD_AMOUNT',
  );
});

test('addBookingAdjustment: 400 on unknown reasonCode', async (t) => {
  const { booking } = await setup(t, 'adj-rsn');
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'NOT_A_REAL_CODE',
    }),
    (err) => err.code === 'ADJUSTMENT_BAD_REASON' && err.status === 400,
  );
});

test('addBookingAdjustment: 409 on CANCELLED', async (t) => {
  const { booking } = await setup(t, 'adj-cxl');
  await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'PROMO',
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('addBookingAdjustment: 409 when DISCOUNT pushes total below paidAmount', async (t) => {
  const { booking } = await setup(t, 'adj-below', { totalAmount: '5000000', paidAmount: '4000000' });
  await assert.rejects(
    () => addBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 2000000, reasonCode: 'GOODWILL',
    }),
    (err) => err.code === 'ADJUSTMENT_BELOW_PAID' && err.status === 409,
  );
});

// ── happy paths ────────────────────────────────────────────────

test('addBookingAdjustment: DISCOUNT subtracts from totalAmount', async (t) => {
  const { booking } = await setup(t, 'adj-disc', { totalAmount: '10000000' });
  const r = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 1500000, reasonCode: 'LOYALTY',
  });
  assert.equal(r.oldTotal, 10000000);
  assert.equal(r.newTotal, 8500000);
  const after = await db.booking.findUnique({
    where: { id: booking.id }, select: { totalAmount: true },
  });
  assert.equal(Number(after.totalAmount.toString()), 8500000);
  // Audit row
  const audit = await db.auditLog.findFirst({
    where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(audit.after.kind, 'DISCOUNT');
  assert.equal(audit.after.reasonCode, 'LOYALTY');
  assert.equal(audit.after.delta, -1500000);
});

test('addBookingAdjustment: SURCHARGE adds to totalAmount', async (t) => {
  const { booking } = await setup(t, 'adj-surch', { totalAmount: '10000000' });
  const r = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'SURCHARGE', amountIdr: 500000, reasonCode: 'CORRECTION',
    reasonNote: 'fix mis-quoted kelas',
  });
  assert.equal(r.newTotal, 10500000);
  assert.equal(r.adjustment.reasonNote, 'fix mis-quoted kelas');
});

test('addBookingAdjustment: amount rounded to integer Rupiah', async (t) => {
  const { booking } = await setup(t, 'adj-round', { totalAmount: '10000000' });
  const r = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 100000.7, reasonCode: 'PROMO',
  });
  assert.equal(Number(r.adjustment.amountIdr.toString()), 100001);
});

test('addBookingAdjustment: reasonCode normalised to uppercase', async (t) => {
  const { booking } = await setup(t, 'adj-case', { totalAmount: '10000000' });
  const r = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'promo',
  });
  assert.equal(r.adjustment.reasonCode, 'PROMO');
});

// ── remove ─────────────────────────────────────────────────────

test('removeBookingAdjustment: reverses totalAmount + deletes row', async (t) => {
  const { booking } = await setup(t, 'adj-rm', { totalAmount: '10000000' });
  const r1 = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 1000000, reasonCode: 'PROMO',
  });
  // total now 9M
  const r2 = await removeBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, adjustmentId: r1.adjustment.id,
  });
  // total back to 10M
  assert.equal(r2.newTotal, 10000000);
  const gone = await db.bookingAdjustment.findUnique({ where: { id: r1.adjustment.id } });
  assert.equal(gone, null);
});

test('removeBookingAdjustment: 409 on cross-booking mismatch', async (t) => {
  const setupA = await setup(t, 'adj-rm-mis-a');
  const setupB = await setup(t, 'adj-rm-mis-b');
  const r = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: setupA.booking.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'PROMO',
  });
  await assert.rejects(
    () => removeBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: setupB.booking.id, // wrong booking
      adjustmentId: r.adjustment.id,
    }),
    (err) => err.code === 'BA_BOOKING_MISMATCH',
  );
});

test('removeBookingAdjustment: 409 when reverse pushes below paid', async (t) => {
  const { booking } = await setup(t, 'adj-rm-below', { totalAmount: '10000000' });
  const r1 = await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'SURCHARGE', amountIdr: 2000000, reasonCode: 'CORRECTION',
  });
  // total = 12M; pay 11M now
  await db.booking.update({ where: { id: booking.id }, data: { paidAmount: '11000000' } });
  // Removing a +2M surcharge would drop total to 10M < 11M paid → refuse
  await assert.rejects(
    () => removeBookingAdjustment({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, adjustmentId: r1.adjustment.id,
    }),
    (err) => err.code === 'ADJUSTMENT_BELOW_PAID',
  );
});

test('listBookingAdjustments: returns rows in creation order', async (t) => {
  const { booking } = await setup(t, 'adj-list', { totalAmount: '10000000' });
  await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'DISCOUNT', amountIdr: 100000, reasonCode: 'PROMO',
  });
  await addBookingAdjustment({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, kind: 'SURCHARGE', amountIdr: 50000, reasonCode: 'CORRECTION',
  });
  const list = await listBookingAdjustments(booking.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, 'DISCOUNT');
  assert.equal(list[1].kind, 'SURCHARGE');
});
