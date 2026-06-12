// Stage 202 — jemaah-side service for picking a pickup point on their
// booking. Validates that:
//   - the booking is owned by the calling jemaah
//   - the pickup belongs to the booking's paket (anti-enumeration)
//   - or `pickupId === null` (jemaah clears their choice)
//
// Idempotent: re-picking the same pickup is a no-op (no audit pollution).

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export async function setMyBookingPickup({ req, actor, userId, bookingId, pickupId }) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, jemaahUserId: userId },
    select: {
      id: true, bookingNo: true, status: true, paketId: true,
      pickupId: true,
      // Stage 212 — paxCount needed for the capacity guard below
      paxCount: true,
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }

  // Normalize input: empty string / undefined / null → null (clear)
  const nextId = pickupId === '' || pickupId == null ? null : String(pickupId);

  // No-op if unchanged (skip audit)
  if ((booking.pickupId ?? null) === nextId) {
    return { updated: false, booking };
  }

  // If picking a non-null pickup, validate it belongs to this paket
  if (nextId !== null) {
    const pickup = await db.paketPickup.findUnique({
      where: { id: nextId },
      select: { id: true, paketId: true, label: true, maxCapacity: true },
    });
    if (!pickup) throw new HttpError(404, 'Pickup tidak ditemukan', 'PICKUP_NOT_FOUND');
    if (pickup.paketId !== booking.paketId) {
      throw new HttpError(400, 'Pickup bukan milik paket ini', 'PICKUP_MISMATCH');
    }
    // Stage 212 — capacity guard. NULL = no cap. Sums paxCount across
    // active bookings already on this pickup (excludes the current
    // booking when re-picking — it's about to move OUT of its old slot).
    // CANCELLED/REFUNDED don't occupy a seat.
    if (pickup.maxCapacity != null) {
      const agg = await db.booking.aggregate({
        _sum: { paxCount: true },
        where: {
          pickupId: nextId,
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
          id: { not: bookingId },
        },
      });
      const occupied = agg._sum.paxCount || 0;
      if (occupied + booking.paxCount > pickup.maxCapacity) {
        throw new HttpError(
          409,
          `Pickup "${pickup.label}" sudah penuh (${occupied}/${pickup.maxCapacity}). Pilih pickup lain.`,
          'PICKUP_FULL',
        );
      }
    }
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { pickupId: nextId },
    select: {
      id: true, pickupId: true,
      pickup: { select: { label: true } },
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { pickupId: booking.pickupId },
    after: {
      pickupId: nextId,
      pickupLabel: updated.pickup?.label || null,
      pickupChosen: true,
    },
  });
  return { updated: true, booking: updated };
}

/**
 * Stage 221 — admin-side pickup setter. Same capacity + cross-paket
 * guards as the jemaah self-pick, but without the `jemaahUserId`
 * ownership requirement (admin can assign on any booking they have
 * RBAC for — route enforces). Useful for walk-in / phone bookings
 * where jemaah doesn't have a /saya account, or as a correction
 * when admin needs to override the jemaah's choice. CANCELLED/
 * REFUNDED bookings still rejected — assigning a pickup to a dead
 * booking is meaningless.
 *
 * Audit row carries `adminSet: true` so the timeline can distinguish
 * admin assignment from jemaah self-pick (the S202 path stamps
 * `pickupChosen: true` instead).
 */
export async function adminSetBookingPickup({ req, actor, bookingId, pickupId }) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, paketId: true,
      pickupId: true, paxCount: true,
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }

  const nextId = pickupId === '' || pickupId == null ? null : String(pickupId);

  // Idempotent no-op
  if ((booking.pickupId ?? null) === nextId) {
    return { updated: false, booking };
  }

  if (nextId !== null) {
    const pickup = await db.paketPickup.findUnique({
      where: { id: nextId },
      select: { id: true, paketId: true, label: true, maxCapacity: true },
    });
    if (!pickup) throw new HttpError(404, 'Pickup tidak ditemukan', 'PICKUP_NOT_FOUND');
    if (pickup.paketId !== booking.paketId) {
      throw new HttpError(400, 'Pickup bukan milik paket ini', 'PICKUP_MISMATCH');
    }
    if (pickup.maxCapacity != null) {
      const agg = await db.booking.aggregate({
        _sum: { paxCount: true },
        where: {
          pickupId: nextId,
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
          id: { not: bookingId },
        },
      });
      const occupied = agg._sum.paxCount || 0;
      if (occupied + booking.paxCount > pickup.maxCapacity) {
        throw new HttpError(
          409,
          `Pickup "${pickup.label}" sudah penuh (${occupied}/${pickup.maxCapacity}). Pilih pickup lain.`,
          'PICKUP_FULL',
        );
      }
    }
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { pickupId: nextId },
    select: {
      id: true, pickupId: true,
      pickup: { select: { label: true } },
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { pickupId: booking.pickupId },
    after: {
      pickupId: nextId,
      pickupLabel: updated.pickup?.label || null,
      adminSet: true,
    },
  });
  return { updated: true, booking: updated };
}
