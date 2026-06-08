import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { subscribePush, pushToUser, pushToAdmins } from '../src/services/webPush.js';
import { notifyBookingCreated, notifyPaymentReceived } from '../src/services/notifications.js';

async function makeSub(t, userId, tag) {
  const sub = await subscribePush({
    userId,
    subscription: {
      endpoint: `https://example.test/push/${tag}-${Math.random().toString(36).slice(2)}`,
      keys: { p256dh: 'a'.repeat(80), auth: 'b'.repeat(20) },
    },
    userAgent: 'test',
  });
  t.after(() => db.pushSubscription.deleteMany({ where: { id: sub.id } }));
  return sub;
}

test('pushToUser: skips silently with no userId', async () => {
  const r = await pushToUser(null, { title: 't', body: 'b', url: '/' });
  assert.equal(r.skipped, true);
  assert.equal(r.delivered, 0);
});

test('pushToUser: skips silently when user has no subscriptions', async (t) => {
  const tag = makeTag('push-empty');
  const j = await tempJemaah(t, tag);
  const r = await pushToUser(j.id, { title: 't', body: 'b', url: '/' });
  assert.equal(r.delivered, 0);
  assert.equal(r.failed, 0);
});

test('pushToUser: delivers to active user subscriptions (fake mode)', async (t) => {
  const tag = makeTag('push-deliver');
  const j = await tempJemaah(t, tag);
  await makeSub(t, j.id, tag);
  await makeSub(t, j.id, `${tag}-2`);

  const r = await pushToUser(j.id, { title: 'hello', body: 'world', url: '/saya' });
  assert.equal(r.delivered, 2, 'both subs delivered');
});

test('pushToUser: scopes by userId (other users do NOT receive)', async (t) => {
  const tag = makeTag('push-scope');
  const j1 = await tempJemaah(t, tag);
  const j2 = await tempJemaah(t, `${tag}-2`);
  await makeSub(t, j1.id, tag);
  await makeSub(t, j2.id, `${tag}-2`);

  const r = await pushToUser(j1.id, { title: 't', body: 'b', url: '/' });
  assert.equal(r.delivered, 1, 'only j1 delivered');
});

test('pushToAdmins: still excludes jemaah subs', async (t) => {
  const tag = makeTag('push-jemaah-vs-admin');
  const j = await tempJemaah(t, tag);
  await tempUser(t, `${tag}-o`, { role: 'OWNER' });
  // Subscribe jemaah only — admins have no subs in this test
  await makeSub(t, j.id, tag);

  const r = await pushToAdmins({ title: 't', body: 'b', url: '/' });
  // jemaah sub must NOT count; admins have no subs → delivered = 0
  assert.equal(r.delivered, 0, 'jemaah sub must NOT be reached by pushToAdmins');
});

test('notifyBookingCreated: fires push when jemaah subscribed', async (t) => {
  const tag = makeTag('push-bc');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await makeSub(t, j.id, tag);

  // Build a synthetic booking object (matches the shape notifyBookingCreated
  // expects after createBooking's relation includes).
  const booking = {
    id: 'fake-booking-' + tag,
    bookingNo: 'RP-TEST-' + tag,
    paket: { title: paket.title },
    jemaah: { fullName: j.fullName, email: j.email, phone: j.phone, userId: j.id },
    jemaahUserId: j.id,
    kelas: 'QUAD',
    paxCount: 2,
    totalAmount: '5000000',
  };

  // No throw on call — the helper writes notifs but the push is best-effort.
  // Fake-mode sendOne just logs, so success is "no throw".
  await notifyBookingCreated(booking);

  // Cleanup the inserted notif rows
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
  });
});
