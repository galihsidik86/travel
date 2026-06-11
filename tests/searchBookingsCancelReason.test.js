// Stage 182 — cancelReasonCode filter on /admin/bookings search.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { searchBookings, CANCEL_REASON_CODES } from '../src/services/bookingsSearch.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

async function makeCancelledBooking(t, tag, reasonCode) {
  const paket = await tempPaket(t, makeTag(`${tag}-p`));
  const jem = await tempJemaah(t, makeTag(`${tag}-j`));
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await cancelBooking({
    req: fakeReq, actor: systemActor, bookingId: b.id,
    reason: `test ${reasonCode}`, reasonCode,
  });
  return b;
}

test('exported CANCEL_REASON_CODES list matches enum', () => {
  assert.deepEqual(CANCEL_REASON_CODES, [
    'JEMAAH_REQUEST', 'PAKET_CANCELLED', 'PAYMENT_NOT_RECEIVED',
    'DOCUMENT_INCOMPLETE', 'NO_SHOW', 'GOODWILL', 'OTHER',
  ]);
});

test('searchBookings: ALL → no cancel-reason filter applied', async (t) => {
  const tag = makeTag('s182-all');
  const b = await makeCancelledBooking(t, tag, 'GOODWILL');
  const r = await searchBookings({ q: b.bookingNo });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].id, b.id);
});

test('searchBookings: filter to GOODWILL surfaces matching only', async (t) => {
  const tag = makeTag('s182-gw');
  const gw = await makeCancelledBooking(t, tag, 'GOODWILL');
  const jr = await makeCancelledBooking(t, tag, 'JEMAAH_REQUEST');
  // both bookings have the same tag in bookingNo → both would match q
  const r = await searchBookings({ q: tag, cancelReasonCode: 'GOODWILL' });
  const ids = r.rows.map((b) => b.id);
  assert.ok(ids.includes(gw.id));
  assert.ok(!ids.includes(jr.id), 'JEMAAH_REQUEST excluded');
});

test('searchBookings: __UNSET__ targets cancelled rows without category', async (t) => {
  const tag = makeTag('s182-unset');
  // One categorised cancel + one un-categorised
  const cat = await makeCancelledBooking(t, tag, 'OTHER');
  const paket = await tempPaket(t, makeTag(`${tag}-p2`));
  const jem = await tempJemaah(t, makeTag(`${tag}-j2`));
  const unset = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await cancelBooking({
    req: fakeReq, actor: systemActor, bookingId: unset.id,
    reason: 'cancel without code',
    // reasonCode omitted entirely
  });
  // Apply __UNSET__ filter — should NOT include the categorised one
  const r = await searchBookings({ q: tag, cancelReasonCode: '__UNSET__' });
  const ids = r.rows.map((b) => b.id);
  assert.ok(ids.includes(unset.id), 'uncategorised cancel surfaced');
  assert.ok(!ids.includes(cat.id), 'categorised cancel excluded');
});

test('searchBookings: unknown cancelReasonCode → silently ignored', async (t) => {
  const tag = makeTag('s182-bad');
  const b = await makeCancelledBooking(t, tag, 'GOODWILL');
  // 'NOT_AN_ENUM' is not in the enum list → filter ignored, returns all matches
  const r = await searchBookings({ q: b.bookingNo, cancelReasonCode: 'NOT_AN_ENUM' });
  assert.equal(r.total, 1, 'unknown code falls through to no filter');
});
