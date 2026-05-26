import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const FLOOR_ORDER = (a, b) => (a.floor ?? 999) - (b.floor ?? 999) || a.roomNo.localeCompare(b.roomNo);

/**
 * Snapshot bunking state for a single paket.
 *   - rooms: every Room belonging to paket, each with its currently-assigned
 *     bookings (+ jemaah names + paxCount + kelas), sorted by floor/wing then roomNo.
 *   - unassigned: bookings (non-CANCELLED/REFUNDED) for this paket without a roomId.
 *
 * Capacity math: occupancy = sum of paxCount across bookings in the room.
 */
export async function getBunkingForPaket(paketSlug) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: { id: true, slug: true, title: true, status: true, kursiTotal: true, kursiTerisi: true },
  });
  if (!paket) return null;

  const [rooms, bookings] = await Promise.all([
    db.room.findMany({
      where: { paketId: paket.id },
      include: {
        bookings: {
          where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
          select: { id: true, bookingNo: true, paxCount: true, kelas: true, status: true,
            jemaah: { select: { fullName: true } } },
        },
      },
      orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
    }),
    db.booking.findMany({
      where: {
        paketId: paket.id,
        roomId: null,
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      select: { id: true, bookingNo: true, paxCount: true, kelas: true, status: true,
        jemaah: { select: { fullName: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const enriched = rooms
    .map((r) => {
      const occupied = r.bookings.reduce((acc, b) => acc + b.paxCount, 0);
      return { ...r, occupied, slotsLeft: r.capacity - occupied };
    })
    .sort(FLOOR_ORDER);

  // Group by floor + wing for the UI
  const byFloor = new Map();
  for (const r of enriched) {
    const key = `${r.floor ?? 'X'}|${r.wing ?? ''}`;
    if (!byFloor.has(key)) byFloor.set(key, { floor: r.floor, wing: r.wing, rooms: [] });
    byFloor.get(key).rooms.push(r);
  }

  return {
    paket,
    floors: [...byFloor.values()],
    unassigned: bookings,
    totals: {
      roomCount: rooms.length,
      capacity: rooms.reduce((acc, r) => acc + r.capacity, 0),
      occupied: enriched.reduce((acc, r) => acc + r.occupied, 0),
      unassignedPax: bookings.reduce((acc, b) => acc + b.paxCount, 0),
    },
  };
}

/**
 * Assign a booking to a room. Validates:
 *   - both exist + same paket
 *   - kelas matches
 *   - capacity has room for booking.paxCount more pax
 *   - booking isn't CANCELLED/REFUNDED
 */
export async function assignBookingToRoom({ req, actor, bookingId, roomId }) {
  const [booking, room] = await Promise.all([
    db.booking.findUnique({ where: { id: bookingId }, include: { paket: { select: { slug: true } } } }),
    db.room.findUnique({
      where: { id: roomId },
      include: {
        bookings: {
          where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
          select: { paxCount: true, id: true },
        },
      },
    }),
  ]);
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (!room) throw new HttpError(404, 'Kamar tidak ditemukan', 'ROOM_NOT_FOUND');
  if (booking.paketId !== room.paketId) {
    throw new HttpError(400, 'Booking dan kamar bukan milik paket yang sama', 'PAKET_MISMATCH');
  }
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa di-assign', 'BOOKING_CLOSED');
  }
  if (booking.kelas !== room.kelas) {
    throw new HttpError(409,
      `Kelas booking (${booking.kelas}) tidak cocok dengan kamar (${room.kelas})`,
      'KELAS_MISMATCH');
  }

  // Don't count this booking's existing slot if it's already in this room (no-op reassign)
  const currentOccupancy = room.bookings
    .filter((b) => b.id !== bookingId)
    .reduce((acc, b) => acc + b.paxCount, 0);
  if (currentOccupancy + booking.paxCount > room.capacity) {
    throw new HttpError(409,
      `Kapasitas kamar ${room.roomNo} tidak cukup: sisa ${room.capacity - currentOccupancy} slot, butuh ${booking.paxCount}`,
      'CAPACITY_EXCEEDED');
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { roomId },
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { roomId: booking.roomId },
    after: { roomId, roomNo: room.roomNo, kelas: room.kelas },
  });

  return updated;
}

/**
 * Remove a booking from its room (slot back to pool).
 */
export async function unassignBooking({ req, actor, bookingId }) {
  const booking = await db.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.roomId == null) return booking; // no-op

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { roomId: null },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { roomId: booking.roomId },
    after: { roomId: null },
  });
  return updated;
}
