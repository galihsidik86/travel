// Stage 270 — payment reminder anchors on next PENDING installment when
// schedule is set; falls back to generic balance message otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { sendPaymentReminders } from '../src/services/paymentReminder.js';
import { setBookingInstallmentSchedule } from '../src/services/bookingInstallments.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function setPaketDeparture(paket, daysFromNow) {
  const departure = new Date();
  departure.setDate(departure.getDate() + daysFromNow);
  await db.paket.update({
    where: { id: paket.id }, data: { departureDate: departure, returnDate: departure },
  });
}

test('sendPaymentReminders: installment line present when schedule set', async (t) => {
  const paket = await tempPaket(t, 'pri-sch');
  const jemaah = await tempJemaah(t, 'pri-sch');
  await setPaketDeparture(paket, 10); // 10 days out
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  // Schedule with first PENDING due 5 days out
  const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + 5);
  const ymd = dueDate.toISOString().slice(0, 10);
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [
      { dueDate: ymd, amountIdr: 5000000 },
      { dueDate: '2026-12-01', amountIdr: 10000000 },
    ],
  });
  const r = await sendPaymentReminders({});
  assert.ok(r.enqueued > 0, 'reminder enqueued');
  // Find the enqueued notif row, check body for installment marker
  const notif = await db.notification.findFirst({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'PAYMENT_REMINDER' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  assert.ok(notif.body.includes('Cicilan'));
  assert.ok(notif.body.includes('5 hari lagi') || notif.body.includes('jatuh tempo'));
});

test('sendPaymentReminders: no installment line when schedule unset', async (t) => {
  const paket = await tempPaket(t, 'pri-noi');
  const jemaah = await tempJemaah(t, 'pri-noi');
  await setPaketDeparture(paket, 10);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  // No schedule set
  const r = await sendPaymentReminders({});
  assert.ok(r.enqueued > 0);
  const notif = await db.notification.findFirst({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'PAYMENT_REMINDER' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  // Body should still mention outstanding balance but NOT the "Cicilan" marker
  assert.ok(!notif.body.includes('Cicilan'));
  assert.ok(notif.body.includes('Sisa pembayaran'));
});

test('sendPaymentReminders: overdue installment marker present', async (t) => {
  const paket = await tempPaket(t, 'pri-ovr');
  const jemaah = await tempJemaah(t, 'pri-ovr');
  await setPaketDeparture(paket, 10);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '15000000' });
  // Schedule with first installment dueDate already in the past
  const past = new Date(); past.setDate(past.getDate() - 3);
  const ymd = past.toISOString().slice(0, 10);
  await setBookingInstallmentSchedule({
    req: fakeReq, actor: adminActor, bookingId: b.id,
    schedule: [{ dueDate: ymd, amountIdr: 5000000 }],
  });
  const r = await sendPaymentReminders({});
  assert.ok(r.enqueued > 0);
  const notif = await db.notification.findFirst({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'PAYMENT_REMINDER' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  assert.ok(notif.body.includes('telat') || notif.body.includes('overdue'));
});
