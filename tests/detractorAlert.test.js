// Stage 315 — detractor alert tests. When score ≤ 4 lands via
// submitTripFeedback, EMAIL fan-out fires to OWNER/SUPERADMIN/MANAJER_OPS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser } from './_helpers.js';
import { submitTripFeedback } from '../src/services/tripFeedback.js';
import { notifyNpsDetractorAlert } from '../src/services/notifications.js';

async function lunasPastPaket(t, tag, jem) {
  const ret = new Date(Date.now() - 30 * 86_400_000);
  const dep = new Date(ret.getTime() - 10 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    // Notification has no booking FK; clean by relatedEntityId via booking IDs.
    const bookings = await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (bookings.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: 'Booking', relatedEntityId: { in: bookings.map((b) => b.id) } },
      });
    }
    await db.tripFeedback.deleteMany({ where: { paketId: paket.id } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-S315-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000',
      status: 'LUNAS',
    },
  });
  return { paket, booking: b };
}

test('S315 — skip when score > 4 (not a detractor)', async () => {
  const r = await notifyNpsDetractorAlert({
    feedback: { score: 7 }, booking: {}, jemaah: {}, paket: {},
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'not_detractor');
});

test('S315 — direct call enqueues EMAIL when admin exists', async (t) => {
  const tag = makeTag('s315a');
  const admin = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const r = await notifyNpsDetractorAlert({
    feedback: { score: 3, comment: 'kurang puas' },
    booking: { id: 'b-test', bookingNo: 'RP-TEST' },
    jemaah: { fullName: 'Test J', phone: '+62811', email: 'j@test' },
    paket: { title: 'Paket X' },
  });
  // Cleanup the notif rows we just created
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  assert.ok(r.enqueued >= 1);
  const notif = await db.notification.findFirst({
    where: { type: 'NPS_DETRACTOR_ALERT', recipientEmail: admin.email },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, body: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /Detractor NPS/);
  assert.match(notif.body, /kurang puas/);
});

test('S315 — submitTripFeedback fires alert when score ≤ 4', async (t) => {
  const tag = makeTag('s315b');
  const admin = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await submitTripFeedback({
    userId: jem.id, bookingId: booking.id, score: 2, comment: 'tidak sesuai ekspektasi',
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  const notif = await db.notification.findFirst({
    where: { type: 'NPS_DETRACTOR_ALERT', recipientEmail: admin.email },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  assert.ok(notif, 'detractor alert fired to admin');
  assert.match(notif.body, /tidak sesuai ekspektasi/);
});

test('S315 — submitTripFeedback does NOT fire alert when score > 4', async (t) => {
  const tag = makeTag('s315c');
  const admin = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const jem = await tempJemaah(t, `${tag}-j`);
  const { booking } = await lunasPastPaket(t, `${tag}-p`, jem);
  await submitTripFeedback({
    userId: jem.id, bookingId: booking.id, score: 9, comment: 'mantap',
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: admin.email } });
  });
  const notif = await db.notification.findFirst({
    where: { type: 'NPS_DETRACTOR_ALERT', recipientEmail: admin.email },
  });
  assert.equal(notif, null, 'no alert for high-score feedback');
});
