// Stage 281 — handover notif fan-out (both old + new jemaah).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { handoverBookingJemaah } from '../src/services/bookingHandover.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('handoverBookingJemaah: fires BOOKING_HANDOVER notif to old jemaah when contact present', async (t) => {
  const paket = await tempPaket(t, 'hbjn-old');
  const jemaah = await tempJemaah(t, 'hbjn-old');
  // Ensure old jemaah profile has phone + email (tempJemaah seeds phone + email)
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const before = await db.notification.count({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'BOOKING_HANDOVER' },
  });
  const r = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'New Owner', phone: '+62888-9999' },
    reason: 'family transfer',
  });
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r.newJemaah.id } }));
  const after = await db.notification.count({
    where: { relatedEntity: 'Booking', relatedEntityId: b.id, type: 'BOOKING_HANDOVER' },
  });
  // Old: email + WA (2 notifs). New: WA only (no email). Total ≥3.
  assert.ok(after - before >= 1, 'at least one handover notif enqueued');
});

test('handoverBookingJemaah: notif to old jemaah carries reason + new jemaah name in payload', async (t) => {
  const paket = await tempPaket(t, 'hbjn-payld');
  const jemaah = await tempJemaah(t, 'hbjn-payld');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'Successor Jane', phone: '+62888-7777' },
    reason: 'reason-token-xyz',
  });
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r.newJemaah.id } }));
  const oldNotif = await db.notification.findFirst({
    where: {
      relatedEntity: 'Booking', relatedEntityId: b.id, type: 'BOOKING_HANDOVER',
      payload: { path: '$.kind', equals: 'handover_old' },
    },
  });
  assert.ok(oldNotif);
  assert.ok(oldNotif.body.includes('reason-token-xyz'), 'reason in body');
  assert.ok(oldNotif.body.includes('Successor Jane'), 'new jemaah name in body');
});

test('handoverBookingJemaah: notif to new jemaah skipped when no contact', async (t) => {
  const paket = await tempPaket(t, 'hbjn-noctct');
  const jemaah = await tempJemaah(t, 'hbjn-noctct');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    // newJemaah has phone (required) but NO email
    newJemaah: { fullName: 'No Email', phone: '+62888-1111' },
    reason: 'new jemaah without email',
  });
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r.newJemaah.id } }));
  // Verify: new-jemaah email-channel notif should NOT exist (phone-only path)
  const newEmailNotif = await db.notification.findFirst({
    where: {
      relatedEntity: 'Booking', relatedEntityId: b.id, type: 'BOOKING_HANDOVER',
      channel: 'EMAIL',
      payload: { path: '$.kind', equals: 'handover_new' },
    },
  });
  assert.equal(newEmailNotif, null, 'no email enqueued when newJemaah has no email');
  // But WA notif to new jemaah SHOULD exist (phone present)
  const newWaNotif = await db.notification.findFirst({
    where: {
      relatedEntity: 'Booking', relatedEntityId: b.id, type: 'BOOKING_HANDOVER',
      channel: 'WA',
      payload: { path: '$.kind', equals: 'handover_new' },
    },
  });
  assert.ok(newWaNotif, 'WA enqueued to new jemaah phone');
});
