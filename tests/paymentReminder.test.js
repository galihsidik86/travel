// Stage 172 — daily payment reminder for jemaah with unpaid balance
// on bookings whose paket departs in <14d. Per-booking cooldown via
// the Notification table.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah } from './_helpers.js';
import {
  getPaymentReminderCandidates, sendPaymentReminders,
  DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS,
} from '../src/services/paymentReminder.js';
import { notifyPaymentReminder } from '../src/services/notifications.js';

async function tempPaketWithDeparture(t, tag, depOffsetDays) {
  const dep = new Date(Date.now() + depOffsetDays * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: { in: (await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } })).map((b) => b.id) } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function tempUnpaidBooking({ paket, jemaahProfileId, status = 'PENDING', total = '1000000', paid = '200000' }) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId: jemaahProfileId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: total, paidAmount: paid, status,
    },
  });
}

test('notifyPaymentReminder: silent when no contact info', async () => {
  const r = await notifyPaymentReminder({
    booking: {
      id: 'x', bookingNo: 'RP-X', paket: { title: 'T', departureDate: new Date() },
      jemaah: { fullName: 'J', phone: null, user: null },
      jemaahUserId: null,
    },
    outstanding: 1000, daysUntil: 5,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_contact');
});

test('getPaymentReminderCandidates: picks unpaid booking within window', async (t) => {
  const tag = makeTag('s172-pick');
  const paket = await tempPaketWithDeparture(t, tag, 10); // departs in 10d
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const { rows } = await getPaymentReminderCandidates({});
  const mine = rows.find((r) => r.id === booking.id);
  assert.ok(mine, 'unpaid booking surfaced');
  assert.equal(mine.bookingNo, booking.bookingNo);
});

test('getPaymentReminderCandidates: excludes LUNAS booking (no balance)', async (t) => {
  const tag = makeTag('s172-lunas');
  const paket = await tempPaketWithDeparture(t, tag, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({
    paket, jemaahProfileId: jem.jemaah.id,
    status: 'LUNAS', paid: '1000000',
  });

  const { rows } = await getPaymentReminderCandidates({});
  const mine = rows.find((r) => r.id === booking.id);
  assert.equal(mine, undefined, 'LUNAS booking not surfaced');
});

test('getPaymentReminderCandidates: excludes CANCELLED booking', async (t) => {
  const tag = makeTag('s172-cancel');
  const paket = await tempPaketWithDeparture(t, tag, 5);
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({
    paket, jemaahProfileId: jem.jemaah.id,
    status: 'CANCELLED',
  });

  const { rows } = await getPaymentReminderCandidates({});
  const mine = rows.find((r) => r.id === booking.id);
  assert.equal(mine, undefined);
});

test('getPaymentReminderCandidates: excludes departure outside window', async (t) => {
  const tag = makeTag('s172-far');
  const paket = await tempPaketWithDeparture(t, tag, 60); // 60d out — beyond default 14d
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const { rows } = await getPaymentReminderCandidates({});
  const mine = rows.find((r) => r.id === booking.id);
  assert.equal(mine, undefined, 'far-departure booking not in 14d window');
});

test('getPaymentReminderCandidates: cooldown excludes recently-nudged booking', async (t) => {
  const tag = makeTag('s172-cool');
  const paket = await tempPaketWithDeparture(t, tag, 10);
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Drop a recent PAYMENT_REMINDER notif for this booking
  await db.notification.create({
    data: {
      type: 'PAYMENT_REMINDER', channel: 'EMAIL', status: 'SENT',
      recipientEmail: 'x@y.test', body: 'prior',
      relatedEntity: 'Booking', relatedEntityId: booking.id,
      sentAt: new Date(),
    },
  });

  const { rows } = await getPaymentReminderCandidates({ cooldownDays: 5 });
  const mine = rows.find((r) => r.id === booking.id);
  assert.equal(mine, undefined, 'recently-nudged booking suppressed');
});

test('sendPaymentReminders: end-to-end enqueues for unpaid booking', async (t) => {
  const tag = makeTag('s172-e2e');
  const paket = await tempPaketWithDeparture(t, tag, 7);
  const jem = await tempJemaah(t, tag);
  const booking = await tempUnpaidBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await sendPaymentReminders({});
  assert.ok(r.enqueued >= 1, 'at least one enqueued');

  const notifs = await db.notification.findMany({
    where: { type: 'PAYMENT_REMINDER', relatedEntityId: booking.id },
  });
  assert.ok(notifs.length >= 1);
  assert.match(notifs[0].body, /sisa pembayaran|outstanding|Rp/i);
});

test('sendPaymentReminders: empty candidates → quiet zero', async () => {
  // No prior fixtures — empty DB for this period
  const r = await sendPaymentReminders({
    now: new Date('2099-01-01'),
  });
  assert.equal(r.bookingCount, 0);
  assert.equal(r.enqueued, 0);
});

test('exported constants sane', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 14);
  assert.equal(DEFAULT_COOLDOWN_DAYS, 5);
});
