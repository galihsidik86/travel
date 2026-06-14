// Stage 288 — jemaah add-on request flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking, tempUser, makeTag } from './_helpers.js';
import { createPaketAddon } from '../src/services/paketAddons.js';
import { requestBookingAddon } from '../src/services/jemaahAddonRequest.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function setup(t, tag) {
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // Link booking to jemaah user so ownership check passes
  await db.booking.update({ where: { id: b.id }, data: { jemaahUserId: jemaah.id } });
  const addon = await createPaketAddon({
    req: fakeReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Test addon', priceIdr: 250000 },
  });
  return { paket, jemaah, booking: b, addon };
}

test('requestBookingAddon: 400 on missing ids', async () => {
  await assert.rejects(
    () => requestBookingAddon({ req: fakeReq, userId: 'x', bookingId: '', addonId: 'x', quantity: 1 }),
    (err) => err.code === 'IDS_REQUIRED' && err.status === 400,
  );
});

test('requestBookingAddon: 400 on bad quantity', async (t) => {
  const { booking, jemaah, addon } = await setup(t, 'jar-bad-qty');
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 0,
    }),
    (err) => err.code === 'ADDON_BAD_QUANTITY',
  );
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 999,
    }),
    (err) => err.code === 'ADDON_QUANTITY_TOO_LARGE',
  );
});

test('requestBookingAddon: 404 when jemaah doesn\'t own the booking', async (t) => {
  const { booking, addon } = await setup(t, 'jar-cross');
  const otherJemaah = await tempJemaah(t, 'jar-cross-other');
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: otherJemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 1,
    }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('requestBookingAddon: 409 on CANCELLED booking', async (t) => {
  const { booking, jemaah, addon } = await setup(t, 'jar-cxl');
  await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 1,
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('requestBookingAddon: 409 on cross-paket addon', async (t) => {
  const { booking, jemaah } = await setup(t, 'jar-cross-pkt');
  // Create an addon on a DIFFERENT paket
  const otherPaket = await tempPaket(t, 'jar-cross-pkt-other');
  const otherAddon = await createPaketAddon({
    req: fakeReq, actor: ownerActor,
    paketSlug: otherPaket.slug,
    input: { name: 'Other paket addon', priceIdr: 100000 },
  });
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: otherAddon.id, quantity: 1,
    }),
    (err) => err.code === 'ADDON_PAKET_MISMATCH' && err.status === 409,
  );
});

test('requestBookingAddon: 409 on inactive addon', async (t) => {
  const { booking, jemaah, addon } = await setup(t, 'jar-inactive');
  await db.paketAddon.update({ where: { id: addon.id }, data: { isActive: false } });
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 1,
    }),
    (err) => err.code === 'ADDON_INACTIVE' && err.status === 409,
  );
});

test('requestBookingAddon: fan-out enqueues EMAIL per admin', async (t) => {
  const { booking, jemaah, addon } = await setup(t, 'jar-success');
  const owner = await tempUser(t, makeTag('jar-success-ow'), { role: 'OWNER' });
  const before = await db.notification.count({
    where: { type: 'GENERIC', relatedEntity: 'Booking', relatedEntityId: booking.id },
  });
  const r = await requestBookingAddon({
    req: fakeReq, userId: jemaah.id,
    bookingId: booking.id, addonId: addon.id, quantity: 2,
  });
  assert.equal(r.requested, true);
  assert.ok(r.adminCount > 0);
  const after = await db.notification.count({
    where: { type: 'GENERIC', relatedEntity: 'Booking', relatedEntityId: booking.id },
  });
  assert.ok(after > before, 'notif enqueued');
  // Verify payload carries addon kind
  const notif = await db.notification.findFirst({
    where: {
      type: 'GENERIC', relatedEntity: 'Booking', relatedEntityId: booking.id,
      recipientEmail: owner.email,
    },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  assert.equal(notif.payload.kind, 'addon_request');
  assert.equal(notif.payload.addonId, addon.id);
  assert.equal(notif.payload.quantity, 2);
});

test('requestBookingAddon: 429 cooldown on duplicate (same addon within 6h)', async (t) => {
  const { booking, jemaah, addon } = await setup(t, 'jar-cd');
  await requestBookingAddon({
    req: fakeReq, userId: jemaah.id,
    bookingId: booking.id, addonId: addon.id, quantity: 1,
  });
  await assert.rejects(
    () => requestBookingAddon({
      req: fakeReq, userId: jemaah.id,
      bookingId: booking.id, addonId: addon.id, quantity: 1,
    }),
    (err) => err.code === 'ADDON_REQUEST_COOLDOWN' && err.status === 429,
  );
});

test('requestBookingAddon: different addonId NOT blocked by cooldown', async (t) => {
  const { booking, jemaah, addon, paket } = await setup(t, 'jar-cd-diff');
  await requestBookingAddon({
    req: fakeReq, userId: jemaah.id,
    bookingId: booking.id, addonId: addon.id, quantity: 1,
  });
  const otherAddon = await createPaketAddon({
    req: fakeReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Second addon', priceIdr: 100000 },
  });
  // Should succeed — different addonId
  const r = await requestBookingAddon({
    req: fakeReq, userId: jemaah.id,
    bookingId: booking.id, addonId: otherAddon.id, quantity: 1,
  });
  assert.equal(r.requested, true);
});
