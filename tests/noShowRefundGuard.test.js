// Stage 145 — refund guard rail when booking has been flagged as no-show.
// Default 100% refund requires explicit acknowledgeNoShow:true so admin
// doesn't accidentally refund a jemaah who actually flew with a
// competitor. Partial refunds (goodwill) don't need the ack.
// Cancel audit row also carries wasNoShow:true for compliance trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempPaket, tempJemaah, tempBooking, fakeReq } from './_helpers.js';
import { issueRefund } from '../src/services/refund.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';
import { recordPayment } from '../src/services/payment.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

async function setupPaidCancelledNoShow(t, tag) {
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, totalAmount: '1000000',
  });
  // Pay then cancel
  await recordPayment({
    req: fakeReq, actor: actor(owner), bookingId: booking.id,
    amount: 1_000_000, method: 'TRANSFER',
  });
  await cancelBooking({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id, reason: 'test setup',
  });
  // Flip noShowAt
  await db.booking.update({
    where: { id: booking.id },
    data: { noShowAt: new Date('2026-06-01') },
  });
  return { owner, booking };
}

test('issueRefund: full refund on no-show without ack → 409 NOSHOW_REFUND_NEEDS_ACK', async (t) => {
  const tag = makeTag('s145-block');
  const { owner, booking } = await setupPaidCancelledNoShow(t, tag);

  await assert.rejects(
    () => issueRefund({
      req: fakeReq, actor: actor(owner),
      bookingId: booking.id,
      amount: 1_000_000,  // full
      method: 'TRANSFER',
      reason: 'jemaah minta refund',
      // no acknowledgeNoShow
    }),
    (err) => err instanceof HttpError && err.status === 409 && err.code === 'NOSHOW_REFUND_NEEDS_ACK',
  );

  // paidAmount unchanged
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(Number(after.paidAmount), 1_000_000, 'no money moved');
});

test('issueRefund: full refund on no-show WITH ack → succeeds + audit carries flag', async (t) => {
  const tag = makeTag('s145-ack');
  const { owner, booking } = await setupPaidCancelledNoShow(t, tag);

  const result = await issueRefund({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id,
    amount: 1_000_000,
    method: 'TRANSFER',
    reason: 'verified offline, jemaah benar batal',
    acknowledgeNoShow: true,
  });
  assert.equal(Number(result.payment.amount), -1_000_000);

  // Audit row reflects no-show context
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: booking.id, action: 'REFUND_ISSUED' },
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.wasNoShow, true);
  assert.equal(audits[0].after.noShowAcknowledged, true);
});

test('issueRefund: partial refund on no-show WITHOUT ack → still allowed', async (t) => {
  const tag = makeTag('s145-partial');
  const { owner, booking } = await setupPaidCancelledNoShow(t, tag);

  // Goodwill partial refund — 30%
  const result = await issueRefund({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id,
    amount: 300_000,  // < paidAmount
    method: 'TRANSFER',
    reason: 'goodwill 30%',
    // no acknowledgeNoShow — partial bypasses the guard
  });
  assert.equal(Number(result.payment.amount), -300_000);

  // Audit row STILL marks wasNoShow:true (the context is durable)
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: booking.id, action: 'REFUND_ISSUED' },
  });
  assert.equal(audits[0].after.wasNoShow, true);
  assert.equal(audits[0].after.noShowAcknowledged, false);
});

test('issueRefund: non-no-show booking unaffected by ack flag', async (t) => {
  const tag = makeTag('s145-noflag');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, totalAmount: '500000',
  });
  await recordPayment({
    req: fakeReq, actor: actor(owner), bookingId: booking.id,
    amount: 500_000, method: 'TRANSFER',
  });
  await cancelBooking({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id, reason: 'no-show off',
  });
  // NO noShowAt stamp

  const result = await issueRefund({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id, amount: 500_000,
    method: 'TRANSFER', reason: 'standard refund',
  });
  assert.equal(Number(result.payment.amount), -500_000);
  // Audit row does NOT carry wasNoShow / noShowAcknowledged keys
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: booking.id, action: 'REFUND_ISSUED' },
  });
  assert.equal(audits[0].after.wasNoShow, undefined);
  assert.equal(audits[0].after.noShowAcknowledged, undefined);
});

test('cancelBooking: no-show stamp surfaces in cancel audit row', async (t) => {
  const tag = makeTag('s145-cancel');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, totalAmount: '1000000',
  });
  // Flag as no-show first (without paying — just to validate audit annotation)
  await db.booking.update({
    where: { id: booking.id },
    data: { noShowAt: new Date('2026-06-01') },
  });

  await cancelBooking({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id, reason: 'closing out no-show',
  });

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: booking.id, action: 'STATUS_CHANGE' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.equal(audits[0].after.status, 'CANCELLED');
  assert.equal(audits[0].after.wasNoShow, true);
  assert.match(audits[0].after.noShowFlaggedAt, /^2026-06-01/);
});
