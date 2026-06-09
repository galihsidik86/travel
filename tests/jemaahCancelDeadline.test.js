// Stage 147 — jemaah cancel deadline lock. Once paket.manifestClosesAt
// passes, requestCancelByJemaah refuses with CANCEL_DEADLINE_PASSED.
// Admin flow (cancelBooking) bypasses this guard entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { requestCancelByJemaah } from '../src/services/jemaahPortal.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'JEMAAH' }; }

test('requestCancelByJemaah: succeeds when manifestClosesAt in the future', async (t) => {
  const tag = makeTag('s147-future');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },  // +7d
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id,
  });

  await requestCancelByJemaah({
    req: fakeReq, actor: actor(jem),
    userId: jem.id, bookingId: booking.id,
    reason: 'changed my mind',
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.cancelRequested, true);
});

test('requestCancelByJemaah: refuses when manifestClosesAt has passed', async (t) => {
  const tag = makeTag('s147-past');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },  // -2d
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id,
  });

  await assert.rejects(
    () => requestCancelByJemaah({
      req: fakeReq, actor: actor(jem),
      userId: jem.id, bookingId: booking.id,
      reason: 'too late',
    }),
    (err) => err instanceof HttpError && err.status === 409 && err.code === 'CANCEL_DEADLINE_PASSED',
  );

  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.cancelRequested, false, 'no state change on lock');
});

test('requestCancelByJemaah: paket without manifestClosesAt never locks', async (t) => {
  const tag = makeTag('s147-noclose');
  const paket = await tempPaket(t, tag);
  // manifestClosesAt is null by default
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id,
  });

  await requestCancelByJemaah({
    req: fakeReq, actor: actor(jem),
    userId: jem.id, bookingId: booking.id,
    reason: 'still open',
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.cancelRequested, true);
});

test('requestCancelByJemaah: now param works for testability', async (t) => {
  const tag = makeTag('s147-now');
  const paket = await tempPaket(t, tag);
  // Set close at fixed past date
  const closeAt = new Date('2026-06-01T00:00:00Z');
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: closeAt },
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id,
  });

  // Force now BEFORE the close → allowed
  await requestCancelByJemaah({
    req: fakeReq, actor: actor(jem),
    userId: jem.id, bookingId: booking.id,
    reason: 'before',
    now: new Date('2026-05-30T00:00:00Z'),
  });
  // Clear so we can re-try
  await db.booking.update({
    where: { id: booking.id },
    data: { cancelRequested: false, cancelRequestedAt: null, cancelRequestReason: null },
  });
  // now AFTER the close → refused
  await assert.rejects(
    () => requestCancelByJemaah({
      req: fakeReq, actor: actor(jem),
      userId: jem.id, bookingId: booking.id,
      reason: 'after',
      now: new Date('2026-06-10T00:00:00Z'),
    }),
    (err) => err instanceof HttpError && err.code === 'CANCEL_DEADLINE_PASSED',
  );
});

test('cancelBooking (admin flow): bypasses the deadline lock', async (t) => {
  const tag = makeTag('s147-admin');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },  // -5d (locked)
  });
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({
    paket, jemaahProfileId: jem.jemaah.id, jemaahUserId: jem.id,
  });

  // Admin can still cancel even though the jemaah-side flow would refuse
  await cancelBooking({
    req: fakeReq, actor: { id: owner.id, email: owner.email, role: 'OWNER' },
    bookingId: booking.id, reason: 'admin override after deadline',
  });
  const after = await db.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.status, 'CANCELLED');
});
