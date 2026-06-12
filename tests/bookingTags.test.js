// Stage 226 — booking tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { setBookingTags, normaliseBookingTags } from '../src/services/bookingAdmin.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('normaliseBookingTags: handles null/empty', () => {
  assert.deepEqual(normaliseBookingTags(null), []);
  assert.deepEqual(normaliseBookingTags([]), []);
  assert.deepEqual(normaliseBookingTags(''), []);
});

test('normaliseBookingTags: CSV string parsed + uppercased + trimmed', () => {
  assert.deepEqual(normaliseBookingTags(' vip, lansia , honeymoon '), ['VIP', 'LANSIA', 'HONEYMOON']);
});

test('normaliseBookingTags: drops non-alphanumeric tags', () => {
  // SPACE inside makes "VIP ROOM" invalid (only A-Z0-9_-)
  assert.deepEqual(normaliseBookingTags(['VIP', 'BAD TAG', '★']), ['VIP']);
});

test('normaliseBookingTags: dedupes case-insensitive', () => {
  assert.deepEqual(normaliseBookingTags(['VIP', 'vip', 'Vip']), ['VIP']);
});

test('normaliseBookingTags: caps at 8 tags', () => {
  const many = Array.from({ length: 12 }, (_, i) => `TAG${i}`);
  const r = normaliseBookingTags(many);
  assert.equal(r.length, 8);
});

test('normaliseBookingTags: per-tag length cap at 24', () => {
  const long = 'A'.repeat(50);
  const r = normaliseBookingTags([long]);
  assert.equal(r[0].length, 24);
});

test('setBookingTags: writes tags + audit row', async (t) => {
  const tag = makeTag('s226-set');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await setBookingTags({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, tags: 'VIP, LANSIA',
  });
  assert.equal(r.updated, true);
  assert.deepEqual(r.tags, ['VIP', 'LANSIA']);

  const fresh = await db.booking.findUnique({ where: { id: b.id }, select: { tags: true } });
  assert.deepEqual(fresh.tags, ['VIP', 'LANSIA']);

  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.equal(audits[0].after.tagsChanged, true);
  assert.deepEqual(audits[0].after.tags, ['VIP', 'LANSIA']);
});

test('setBookingTags: empty list clears to NULL', async (t) => {
  const tag = makeTag('s226-clear');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { tags: ['VIP'] } });

  const r = await setBookingTags({ req: fakeReq, actor: adminActor, bookingId: b.id, tags: '' });
  assert.equal(r.updated, true);
  assert.deepEqual(r.tags, []);
  const fresh = await db.booking.findUnique({ where: { id: b.id }, select: { tags: true } });
  assert.equal(fresh.tags, null);
});

test('setBookingTags: idempotent re-save → no audit pollution', async (t) => {
  const tag = makeTag('s226-idempotent');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  await setBookingTags({ req: fakeReq, actor: adminActor, bookingId: b.id, tags: 'VIP' });
  // Snapshot audit count
  const beforeCount = await db.auditLog.count({ where: { entity: 'Booking', entityId: b.id } });
  // Re-save same
  const r = await setBookingTags({ req: fakeReq, actor: adminActor, bookingId: b.id, tags: 'VIP' });
  assert.equal(r.updated, false);
  const afterCount = await db.auditLog.count({ where: { entity: 'Booking', entityId: b.id } });
  assert.equal(afterCount, beforeCount, 'no audit row written on no-op');
});

test('setBookingTags: 404 on unknown booking', async () => {
  await assert.rejects(
    () => setBookingTags({ req: fakeReq, actor: adminActor, bookingId: 'no-such', tags: 'VIP' }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('setBookingTags: refuses on CANCELLED', async (t) => {
  const tag = makeTag('s226-cancelled');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: b.id } }); });

  await assert.rejects(
    () => setBookingTags({ req: fakeReq, actor: adminActor, bookingId: b.id, tags: 'VIP' }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});
