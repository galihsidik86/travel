// Stage 75 — first payment thanks fires once per booking.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq } from './_helpers.js';
import { recordPayment } from '../src/services/payment.js';

const systemActor = { email: 'test', role: 'KASIR' };

async function setupBooking(t, tag, totalAmount = '10000000') {
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-FPT`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount, paidAmount: '0', status: 'PENDING',
    },
  });
  // give jemaah profile an email so notif has a recipient
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { email: `${tag}@example.test` },
  });
  return { user: jem, paket, booking: b };
}

test('fires FIRST_PAYMENT_THANKS on the first PAID payment', async (t) => {
  const tag = makeTag('fpt-first');
  const { user, booking } = await setupBooking(t, tag);

  await recordPayment({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id,
    amount: 1000000, method: 'TRANSFER',
  });

  const notif = await db.notification.findFirst({
    where: { type: 'FIRST_PAYMENT_THANKS', relatedEntityId: booking.id },
    select: { subject: true, body: true, recipientUserId: true },
  });
  assert.ok(notif, 'FIRST_PAYMENT_THANKS row must exist');
  assert.match(notif.subject, /Terima kasih/i);
  assert.equal(notif.recipientUserId, user.id);
  await db.notification.deleteMany({ where: { relatedEntityId: booking.id } });
});

test('does NOT fire on the second payment (only once per booking)', async (t) => {
  const tag = makeTag('fpt-second');
  const { booking } = await setupBooking(t, tag);

  await recordPayment({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id, amount: 500000, method: 'TRANSFER',
  });
  await recordPayment({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id, amount: 500000, method: 'TRANSFER',
  });

  const notifs = await db.notification.findMany({
    where: { type: 'FIRST_PAYMENT_THANKS', relatedEntityId: booking.id },
  });
  assert.equal(notifs.length, 1, 'must NOT fire twice');
  await db.notification.deleteMany({ where: { relatedEntityId: booking.id } });
});
