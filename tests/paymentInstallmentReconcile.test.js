// Stage 269 — recordPayment auto-marks installments PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { recordPayment } from '../src/services/payment.js';
import { setBookingInstallmentSchedule } from '../src/services/bookingInstallments.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('recordPayment: marks first PENDING installment PAID when amount covers it', async (t) => {
  const paket = await tempPaket(t, 'pir-mark');
  const jemaah = await tempJemaah(t, 'pir-mark');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [
      { dueDate: '2026-06-01', amountIdr: 5000000 },
      { dueDate: '2026-07-01', amountIdr: 5000000 },
      { dueDate: '2026-08-01', amountIdr: 5000000 },
    ],
  });
  await recordPayment({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    amount: 5000000, method: 'TRANSFER',
  });
  const after = await db.booking.findUnique({
    where: { id: b.id }, select: { installmentSchedule: true },
  });
  assert.equal(after.installmentSchedule[0].status, 'PAID');
  assert.ok(after.installmentSchedule[0].paidAt);
  assert.equal(after.installmentSchedule[1].status, 'PENDING');
  assert.equal(after.installmentSchedule[2].status, 'PENDING');
});

test('recordPayment: marks multiple installments when amount covers them', async (t) => {
  const paket = await tempPaket(t, 'pir-multi');
  const jemaah = await tempJemaah(t, 'pir-multi');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [
      { dueDate: '2026-06-01', amountIdr: 3000000 },
      { dueDate: '2026-07-01', amountIdr: 3000000 },
      { dueDate: '2026-08-01', amountIdr: 3000000 },
    ],
  });
  await recordPayment({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    amount: 7000000, method: 'TRANSFER',
  });
  const after = await db.booking.findUnique({
    where: { id: b.id }, select: { installmentSchedule: true },
  });
  assert.equal(after.installmentSchedule[0].status, 'PAID');
  assert.equal(after.installmentSchedule[1].status, 'PAID');
  assert.equal(after.installmentSchedule[2].status, 'PENDING'); // 1M leftover not enough for #3
});

test('recordPayment: partial amount short of next installment leaves all PENDING', async (t) => {
  const paket = await tempPaket(t, 'pir-shor');
  const jemaah = await tempJemaah(t, 'pir-shor');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [{ dueDate: '2026-06-01', amountIdr: 5000000 }],
  });
  await recordPayment({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    amount: 3000000, method: 'TRANSFER',
  });
  const after = await db.booking.findUnique({
    where: { id: b.id }, select: { installmentSchedule: true, paidAmount: true },
  });
  // Schedule untouched
  assert.equal(after.installmentSchedule[0].status, 'PENDING');
  // But paidAmount still bumped by the canonical money path
  assert.equal(Number(after.paidAmount), 3000000);
});

test('recordPayment: booking without schedule still works (back-compat)', async (t) => {
  const paket = await tempPaket(t, 'pir-bc');
  const jemaah = await tempJemaah(t, 'pir-bc');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  // No schedule set — installmentSchedule stays null
  const r = await recordPayment({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    amount: 5000000, method: 'TRANSFER',
  });
  assert.ok(r.payment);
  const after = await db.booking.findUnique({
    where: { id: b.id }, select: { installmentSchedule: true, paidAmount: true },
  });
  assert.equal(after.installmentSchedule, null);
  assert.equal(Number(after.paidAmount), 5000000);
});

test('recordPayment: audit row carries installmentsMarkedPaid count when reconcile happened', async (t) => {
  const paket = await tempPaket(t, 'pir-aud');
  const jemaah = await tempJemaah(t, 'pir-aud');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [
      { dueDate: '2026-06-01', amountIdr: 3000000 },
      { dueDate: '2026-07-01', amountIdr: 3000000 },
    ],
  });
  await recordPayment({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    amount: 6000000, method: 'TRANSFER',
  });
  const audit = await db.auditLog.findFirst({
    where: { entity: 'Booking', entityId: b.id, action: 'PAYMENT_RECEIVED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit);
  assert.equal(audit.after.installmentsMarkedPaid, 2);
});
