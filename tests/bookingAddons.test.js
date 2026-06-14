// Stage 284 — booking add-on attach/remove + totalAmount mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { createPaketAddon } from '../src/services/paketAddons.js';
import {
  attachBookingAddon,
  removeBookingAddon,
  listBookingAddons,
} from '../src/services/bookingAddons.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function setupBookingWithAddon(t, tag) {
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '10000000' });
  const addon = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: paket.slug,
    input: { name: 'Extra baggage 30kg', priceIdr: 500000 },
  });
  return { paket, jemaah, booking: b, addon };
}

test('attachBookingAddon: 400 on missing bookingId / addonId', async () => {
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: '', addonId: 'x',
    }),
    (err) => err.code === 'BOOKING_ID_REQUIRED' && err.status === 400,
  );
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: 'x', addonId: '',
    }),
    (err) => err.code === 'ADDON_ID_REQUIRED' && err.status === 400,
  );
});

test('attachBookingAddon: 400 on bad quantity', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-qty');
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, addonId: addon.id, quantity: 0,
    }),
    (err) => err.code === 'ADDON_BAD_QUANTITY',
  );
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, addonId: addon.id, quantity: 999,
    }),
    (err) => err.code === 'ADDON_QUANTITY_TOO_LARGE',
  );
});

test('attachBookingAddon: 409 on CANCELLED booking', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-cxl');
  await db.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, addonId: addon.id,
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('attachBookingAddon: 409 when addonId belongs to a different paket', async (t) => {
  const setupA = await setupBookingWithAddon(t, 'ba-mismatch-a');
  const otherPaket = await tempPaket(t, 'ba-mismatch-other');
  const otherAddon = await createPaketAddon({
    req: ownerReq, actor: ownerActor,
    paketSlug: otherPaket.slug,
    input: { name: 'Other paket addon', priceIdr: 100000 },
  });
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: setupA.booking.id, addonId: otherAddon.id,
    }),
    (err) => err.code === 'ADDON_PAKET_MISMATCH' && err.status === 409,
  );
});

test('attachBookingAddon: 409 on inactive addon', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-inactive');
  await db.paketAddon.update({ where: { id: addon.id }, data: { isActive: false } });
  await assert.rejects(
    () => attachBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, addonId: addon.id,
    }),
    (err) => err.code === 'ADDON_INACTIVE' && err.status === 409,
  );
});

test('attachBookingAddon: success bumps Booking.totalAmount + creates BookingAddon row', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-success');
  const r = await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, addonId: addon.id, quantity: 2,
  });
  assert.equal(r.newTotal, 11000000); // 10M + (500k × 2)
  assert.equal(r.bookingAddon.quantity, 2);
  assert.equal(r.bookingAddon.nameSnapshot, 'Extra baggage 30kg');
  assert.equal(Number(r.bookingAddon.priceIdrSnapshot.toString()), 500000);

  // Verify in DB
  const after = await db.booking.findUnique({
    where: { id: booking.id }, select: { totalAmount: true },
  });
  assert.equal(Number(after.totalAmount.toString()), 11000000);

  // Audit row
  const audit = await db.auditLog.findFirst({
    where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(audit.after.addonAttached, true);
  assert.equal(audit.after.lineTotal, 1000000);
});

test('attachBookingAddon: subsequent catalog price change does NOT alter snapshot', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-snapshot');
  const r = await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, addonId: addon.id,
  });
  // Mutate catalog
  await db.paketAddon.update({
    where: { id: addon.id }, data: { priceIdr: '999000.00' },
  });
  // Snapshot still reflects original
  const ba = await db.bookingAddon.findUnique({ where: { id: r.bookingAddon.id } });
  assert.equal(Number(ba.priceIdrSnapshot.toString()), 500000);
});

test('removeBookingAddon: decrements totalAmount + deletes row', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-remove');
  const r1 = await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, addonId: addon.id, quantity: 3,
  });
  // total now 10M + (500k × 3) = 11.5M
  assert.equal(r1.newTotal, 11500000);
  const r2 = await removeBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, bookingAddonId: r1.bookingAddon.id,
  });
  assert.equal(r2.removed, true);
  assert.equal(r2.newTotal, 10000000);
  // Row gone
  const gone = await db.bookingAddon.findUnique({ where: { id: r1.bookingAddon.id } });
  assert.equal(gone, null);
});

test('removeBookingAddon: 404 on unknown bookingAddonId', async (t) => {
  const { booking } = await setupBookingWithAddon(t, 'ba-rmunk');
  await assert.rejects(
    () => removeBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: booking.id, bookingAddonId: 'cknotexist',
    }),
    (err) => err.code === 'BA_NOT_FOUND',
  );
});

test('removeBookingAddon: 409 on bookingId / bookingAddonId mismatch', async (t) => {
  const setupA = await setupBookingWithAddon(t, 'ba-rmmis-a');
  const setupB = await setupBookingWithAddon(t, 'ba-rmmis-b');
  const r = await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: setupA.booking.id, addonId: setupA.addon.id,
  });
  await assert.rejects(
    () => removeBookingAddon({
      req: ownerReq, actor: ownerActor,
      bookingId: setupB.booking.id, // different booking
      bookingAddonId: r.bookingAddon.id,
    }),
    (err) => err.code === 'BA_BOOKING_MISMATCH',
  );
});

test('listBookingAddons: returns attached addons in creation order', async (t) => {
  const { booking, addon } = await setupBookingWithAddon(t, 'ba-list');
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, addonId: addon.id, quantity: 1,
  });
  await attachBookingAddon({
    req: ownerReq, actor: ownerActor,
    bookingId: booking.id, addonId: addon.id, quantity: 2,
  });
  const list = await listBookingAddons(booking.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].quantity, 1);
  assert.equal(list[1].quantity, 2);
});
