// Stage 284 — attach/remove add-ons from a booking. Mutates
// Booking.totalAmount in the same transaction so the existing money
// flow (status transitions via transitionStatus, LUNAS-on-paid logic,
// installment reconcile) all stay correct.
//
// Price is snapshotted from PaketAddon at attach time (priceIdrSnapshot
// + nameSnapshot). Catalog edits to the source PaketAddon don't
// retroactively affect committed BookingAddon rows.
//
// Status guards: same convention as setBookingTags / setBookingGroupKey —
// CANCELLED/REFUNDED refused (frozen state). Add-on against the booking's
// paket only (cross-paket addonId rejected).

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const MAX_QTY = 50;

function n(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

/**
 * Attach an add-on to a booking.
 *   - quantity defaults to 1 (most add-ons are buy-once)
 *   - bumps booking.totalAmount by (quantity × price) inside one tx
 *   - returns {bookingAddon, newTotal}
 */
export async function attachBookingAddon({ req, actor, bookingId, addonId, quantity = 1 }) {
  if (!bookingId) throw new HttpError(400, 'Booking ID wajib', 'BOOKING_ID_REQUIRED');
  if (!addonId) throw new HttpError(400, 'Addon ID wajib', 'ADDON_ID_REQUIRED');
  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1) {
    throw new HttpError(400, 'Quantity harus angka ≥ 1', 'ADDON_BAD_QUANTITY');
  }
  if (qty > MAX_QTY) {
    throw new HttpError(400, `Quantity maksimal ${MAX_QTY}`, 'ADDON_QUANTITY_TOO_LARGE');
  }

  const [booking, addon] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, bookingNo: true, status: true, totalAmount: true, paketId: true },
    }),
    db.paketAddon.findUnique({
      where: { id: addonId },
      select: { id: true, paketId: true, name: true, priceIdr: true, isActive: true },
    }),
  ]);
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — add-on tidak diizinkan', 'BOOKING_CLOSED');
  }
  if (!addon) throw new HttpError(404, 'Add-on tidak ditemukan', 'ADDON_NOT_FOUND');
  if (addon.paketId !== booking.paketId) {
    throw new HttpError(409, 'Add-on bukan milik paket booking ini', 'ADDON_PAKET_MISMATCH');
  }
  if (!addon.isActive) {
    throw new HttpError(409, 'Add-on tidak aktif — aktifkan dulu di katalog', 'ADDON_INACTIVE');
  }

  const priceSnapshot = Math.round(n(addon.priceIdr));
  const lineTotal = priceSnapshot * qty;
  const newTotal = n(booking.totalAmount) + lineTotal;

  const result = await db.$transaction(async (tx) => {
    const ba = await tx.bookingAddon.create({
      data: {
        bookingId, addonId,
        nameSnapshot: addon.name,
        priceIdrSnapshot: priceSnapshot.toFixed(2),
        quantity: qty,
        createdByEmail: actor?.email || null,
      },
    });
    await tx.booking.update({
      where: { id: bookingId },
      data: { totalAmount: newTotal.toFixed(2) },
    });
    return ba;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { totalAmount: n(booking.totalAmount) },
    after: {
      totalAmount: newTotal,
      addonAttached: true,
      addonId, addonName: addon.name,
      priceIdrSnapshot: priceSnapshot, quantity: qty, lineTotal,
      bookingAddonId: result.id,
    },
  });

  return { bookingAddon: result, newTotal };
}

/**
 * Remove a previously-attached add-on. Decrements booking.totalAmount
 * by the snapshotted (price × quantity). Same status guards as attach.
 *
 * Refuses if the resulting totalAmount would go negative (safety guard
 * — should never happen with correct data but defensive against
 * concurrent edits / corrupted rows).
 */
export async function removeBookingAddon({ req, actor, bookingId, bookingAddonId }) {
  if (!bookingId || !bookingAddonId) {
    throw new HttpError(400, 'bookingId + bookingAddonId wajib', 'IDS_REQUIRED');
  }

  const [booking, ba] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, totalAmount: true },
    }),
    db.bookingAddon.findUnique({
      where: { id: bookingAddonId },
      select: {
        id: true, bookingId: true, nameSnapshot: true,
        priceIdrSnapshot: true, quantity: true,
      },
    }),
  ]);
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (!ba) throw new HttpError(404, 'BookingAddon tidak ditemukan', 'BA_NOT_FOUND');
  if (ba.bookingId !== bookingId) {
    throw new HttpError(409, 'Mismatched booking/addon pair', 'BA_BOOKING_MISMATCH');
  }
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }

  const lineTotal = Math.round(n(ba.priceIdrSnapshot)) * ba.quantity;
  const newTotal = n(booking.totalAmount) - lineTotal;
  if (newTotal < 0) {
    throw new HttpError(409, 'Pengurangan add-on membuat total negatif (data corrupt?)', 'NEGATIVE_TOTAL');
  }

  await db.$transaction(async (tx) => {
    await tx.bookingAddon.delete({ where: { id: bookingAddonId } });
    await tx.booking.update({
      where: { id: bookingId },
      data: { totalAmount: newTotal.toFixed(2) },
    });
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { totalAmount: n(booking.totalAmount) },
    after: {
      totalAmount: newTotal,
      addonRemoved: true,
      bookingAddonId,
      addonName: ba.nameSnapshot,
      priceIdrSnapshot: Math.round(n(ba.priceIdrSnapshot)),
      quantity: ba.quantity,
      lineTotal,
    },
  });

  return { removed: true, newTotal };
}

/** List add-ons attached to a booking (for view rendering). */
export async function listBookingAddons(bookingId) {
  return db.bookingAddon.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, nameSnapshot: true, priceIdrSnapshot: true, quantity: true,
      addonId: true, createdAt: true, createdByEmail: true,
    },
  });
}

export { MAX_QTY };
