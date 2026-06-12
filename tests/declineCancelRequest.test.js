// Stage 224 — admin declines a jemaah's cancel request without cancelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { declineCancelRequest } from '../src/services/bookingAdmin.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function bookingWithRequest(t, tag) {
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id, jemaahUserId: u.id });
  await db.booking.update({
    where: { id: b.id },
    data: {
      cancelRequested: true,
      cancelRequestedAt: new Date(),
      cancelRequestReason: 'jemaah ingin batal',
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: b.id } });
  });
  return { paket, u, b };
}

test('declineCancelRequest: 400 when reason missing or <3 chars', async (t) => {
  const tag = makeTag('s224-noreason');
  const { b } = await bookingWithRequest(t, tag);
  await assert.rejects(
    () => declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'ab' }),
    (err) => err.code === 'DECLINE_REASON_REQUIRED' && err.status === 400,
  );
});

test('declineCancelRequest: 404 on unknown booking', async () => {
  await assert.rejects(
    () => declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: 'no-such', reason: 'too long lost' }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('declineCancelRequest: 409 when no pending request', async (t) => {
  const tag = makeTag('s224-nopending');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // cancelRequested is false by default
  await assert.rejects(
    () => declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'no signal' }),
    (err) => err.code === 'NO_PENDING_REQUEST' && err.status === 409,
  );
});

test('declineCancelRequest: 409 when booking already CANCELLED', async (t) => {
  const tag = makeTag('s224-cancelled');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
      cancelRequested: true,
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: b.id } }); });

  await assert.rejects(
    () => declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'too late' }),
    (err) => err.code === 'ALREADY_CLOSED' && err.status === 409,
  );
});

test('declineCancelRequest: clears the 3 cancelRequest* fields + writes audit', async (t) => {
  const tag = makeTag('s224-clear');
  const { b } = await bookingWithRequest(t, tag);

  const result = await declineCancelRequest({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, reason: 'masih ada cicilan; kami hubungi jemaah dulu',
  });
  assert.equal(result.bookingNo, b.bookingNo);
  // Booking state cleared
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { cancelRequested: true, cancelRequestedAt: true, cancelRequestReason: true } });
  assert.equal(after.cancelRequested, false);
  assert.equal(after.cancelRequestedAt, null);
  assert.equal(after.cancelRequestReason, null);
  // Audit row with the decline marker
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'STATUS_CHANGE' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.equal(audits[0].after.cancelRequestDeclined, true);
  assert.match(audits[0].after.declineReason, /masih ada cicilan/);
});

test('declineCancelRequest: enqueues GENERIC notif to jemaah', async (t) => {
  const tag = makeTag('s224-notif');
  const { b } = await bookingWithRequest(t, tag);

  await declineCancelRequest({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, reason: 'cek dengan agen dulu',
  });

  const rows = await db.notification.findMany({ where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'GENERIC' } });
  // Both EMAIL + WA when both contacts present
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => r.subject.includes('ditolak')));
  assert.ok(rows.some((r) => r.body.includes('cek dengan agen dulu')));
});

test('declineCancelRequest: idempotent — second decline → NO_PENDING_REQUEST', async (t) => {
  const tag = makeTag('s224-idempotent');
  const { b } = await bookingWithRequest(t, tag);
  await declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'reason one' });

  // Second call should error — there's no pending request anymore
  await assert.rejects(
    () => declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'reason two' }),
    (err) => err.code === 'NO_PENDING_REQUEST',
  );
});

test('declineCancelRequest: notif failure does NOT abort the decline', async (t) => {
  // We can't easily induce a notif failure without mocking, but we can
  // verify that a booking with NO contact info still decline-clears
  // successfully — the notif helper short-circuits with skipped.
  const tag = makeTag('s224-nocontact');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { email: null, phone: '' } });
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({
    where: { id: b.id },
    data: { cancelRequested: true, cancelRequestedAt: new Date(), cancelRequestReason: 'x' },
  });

  // Phone column has min length but empty string trips db.booking.update with empty —
  // skip this scenario if it can't be set; otherwise the decline should still clear.
  const r = await declineCancelRequest({ req: fakeReq, actor: adminActor, bookingId: b.id, reason: 'silent decline' });
  assert.equal(r.bookingNo, b.bookingNo);
});
