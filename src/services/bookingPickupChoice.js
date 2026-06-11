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
      select: { id: true, paketId: true, label: true },
    });
    if (!pickup) throw new HttpError(404, 'Pickup tidak ditemukan', 'PICKUP_NOT_FOUND');
    if (pickup.paketId !== booking.paketId) {
      throw new HttpError(400, 'Pickup bukan milik paket ini', 'PICKUP_MISMATCH');
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
