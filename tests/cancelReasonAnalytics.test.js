// Stage 175 — structured cancel reason code + analytics breakdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';
import { getCancelReasonBreakdown } from '../src/services/cancelReasonAnalytics.js';

test('cancelBooking: accepts valid reasonCode', async (t) => {
  const tag = makeTag('s175-valid');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await cancelBooking({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id, reason: 'Jemaah pulled out',
    reasonCode: 'JEMAAH_REQUEST',
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.cancelReasonCode, 'JEMAAH_REQUEST');
});

test('cancelBooking: rejects unknown reasonCode', async (t) => {
  const tag = makeTag('s175-bad');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await assert.rejects(
    cancelBooking({
      req: fakeReq, actor: systemActor,
      bookingId: booking.id, reason: 'test',
      reasonCode: 'INVENTED',
    }),
    /BAD_CANCEL_REASON_CODE|tidak valid/,
  );
});

test('cancelBooking: case-insensitive code normalises uppercase', async (t) => {
  const tag = makeTag('s175-case');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await cancelBooking({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id, reason: 'lowercase test',
    reasonCode: 'goodwill',
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.cancelReasonCode, 'GOODWILL');
});

test('cancelBooking: null reasonCode allowed (back-compat)', async (t) => {
  const tag = makeTag('s175-null');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await cancelBooking({
    req: fakeReq, actor: systemActor,
    bookingId: booking.id, reason: 'no category picked',
    // reasonCode omitted entirely
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.cancelReasonCode, null);
});

test('getCancelReasonBreakdown: empty window → total=0', async () => {
  const r = await getCancelReasonBreakdown({
    days: 1, now: new Date('2099-01-01'),
  });
  assert.equal(r.total, 0);
  assert.equal(r.rows.length, 0);
});

test('getCancelReasonBreakdown: groups + percentages + sort', async (t) => {
  const tag = makeTag('s175-bd');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // 3 JEMAAH_REQUEST + 1 GOODWILL + 1 unset
  for (let i = 0; i < 3; i++) {
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await cancelBooking({
      req: fakeReq, actor: systemActor, bookingId: b.id,
      reason: 'request', reasonCode: 'JEMAAH_REQUEST',
    });
  }
  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await cancelBooking({
    req: fakeReq, actor: systemActor, bookingId: b1.id,
    reason: 'goodwill', reasonCode: 'GOODWILL',
  });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await cancelBooking({
    req: fakeReq, actor: systemActor, bookingId: b2.id,
    reason: 'unset reason',
  });

  const r = await getCancelReasonBreakdown({ days: 365 });
  // Find our test rows (others may exist in DB from prior tests)
  const jr = r.rows.find((x) => x.code === 'JEMAAH_REQUEST');
  const gw = r.rows.find((x) => x.code === 'GOODWILL');
  const un = r.rows.find((x) => x.code === '__UNSET__');
  assert.ok(jr.count >= 3);
  assert.ok(gw.count >= 1);
  assert.ok(un.count >= 1);
  // Unset bucket is always last regardless of count
  const unsetIdx = r.rows.findIndex((x) => x.code === '__UNSET__');
  assert.equal(unsetIdx, r.rows.length - 1, '__UNSET__ stays at end');
});
