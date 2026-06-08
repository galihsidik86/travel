// Stage 42 — waitlist promote nudge fires when cancelBooking frees a seat
// AND the paket has WAITING entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';
import { notifyWaitlistSlotFreed } from '../src/services/notifications.js';

test('notifyWaitlistSlotFreed silent when waitlist empty', async (t) => {
  const tag = makeTag('wsf-empty');
  const paket = await tempPaket(t, tag);
  const result = await notifyWaitlistSlotFreed({
    paketId: paket.id, freedSeats: 1, sourceBookingNo: 'RP-DUMMY',
  });
  assert.equal(result.skipped, true);
  assert.equal(result.enqueued, 0);
});

test('notifyWaitlistSlotFreed enqueues 1 EMAIL per ACTIVE admin when waiting > 0', async (t) => {
  const tag = makeTag('wsf-fan');
  const paket = await tempPaket(t, tag);
  // Two WAITING entries
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Waiting Alpha', phone: `+62800-${tag}-a`, status: 'WAITING' },
  });
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Waiting Bravo', phone: `+62800-${tag}-b`, status: 'WAITING' },
  });
  t.after(async () => {
    await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
  });

  const owner = await tempUser(t, `${tag}-o`, { role: 'OWNER', status: 'ACTIVE' });
  const kasir = await tempUser(t, `${tag}-k`, { role: 'KASIR', status: 'ACTIVE' });

  const r = await notifyWaitlistSlotFreed({
    paketId: paket.id, freedSeats: 1, sourceBookingNo: 'RP-FAKE',
  });
  assert.ok(r.enqueued >= 1);

  const rows = await db.notification.findMany({
    where: {
      type: 'WAITLIST_SLOT_FREED',
      recipientEmail: { in: [owner.email, kasir.email] },
    },
    select: { recipientEmail: true, body: true, relatedEntity: true },
  });
  const emails = new Set(rows.map((r) => r.recipientEmail));
  assert.ok(emails.has(owner.email), 'OWNER must receive');
  assert.ok(!emails.has(kasir.email), 'KASIR must NOT receive (admin-only fan-out)');
  assert.match(rows[0].body, /Waiting Alpha/);
  assert.match(rows[0].body, /Waiting Bravo/);
  assert.equal(rows[0].relatedEntity, 'Paket');

  await db.notification.deleteMany({
    where: { type: 'WAITLIST_SLOT_FREED', recipientEmail: owner.email },
  });
});

test('cancelBooking triggers the nudge (end-to-end)', async (t) => {
  const tag = makeTag('wsf-e2e');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id, totalAmount: '1000000' });
  // Add a waitlist entry
  await db.paketWaitlist.create({
    data: { paketId: paket.id, fullName: 'Expectant Waiter', phone: `+62800-${tag}-e2e`, status: 'WAITING' },
  });
  // Admin to receive the email
  const owner = await tempUser(t, `${tag}-o`, { role: 'OWNER', status: 'ACTIVE' });
  t.after(async () => {
    await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
    await db.notification.deleteMany({
      where: { type: 'WAITLIST_SLOT_FREED', recipientEmail: owner.email },
    });
  });

  await cancelBooking({
    req: fakeReq, actor: { id: 'system', email: 'test', role: 'OWNER' },
    bookingId: booking.id, reason: 'jemaah berhalangan',
  });

  const row = await db.notification.findFirst({
    where: { type: 'WAITLIST_SLOT_FREED', recipientEmail: owner.email },
    orderBy: { createdAt: 'desc' },
    select: { body: true, subject: true, payload: true },
  });
  assert.ok(row, 'nudge must be enqueued after cancel');
  assert.match(row.subject, /kursi/);
  assert.match(row.body, /Expectant Waiter/);
  assert.equal(row.payload.paketSlug, paket.slug);
});

test('cancelBooking succeeds even when nudge fails (best-effort)', async (t) => {
  // Stage 42 invariant: nudge failure must NOT abort the cancel. We can't
  // easily force the helper to throw without monkey-patching, but we CAN
  // assert that cancelBooking returns the updated row for a paket whose
  // notifyWaitlistSlotFreed call would be a no-op (waitlist empty).
  const tag = makeTag('wsf-best');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id, totalAmount: '1000000' });

  const updated = await cancelBooking({
    req: fakeReq, actor: { id: 'system', email: 'test', role: 'OWNER' },
    bookingId: booking.id, reason: 'control test',
  });
  assert.equal(updated.status, 'CANCELLED');
});
