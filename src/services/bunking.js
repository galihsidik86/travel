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
 * Stage 200 — bulk assign unassigned bookings to available rooms on
 * a single floor. Greedy first-fit by kelas: for each unassigned
 * booking (in createdAt order), find the first room on `floor` with
 * matching kelas + remaining capacity ≥ paxCount, and assign.
 *
 * Returns `{ assigned, skipped, errors }` arrays with per-row info
 * so the UI can show "5 assigned, 2 skipped (capacity), 1 error".
 *
 * Whole call non-transactional — each assign is its own DB write +
 * audit row. Partial success is fine (admin re-runs to pick up
 * whatever rooms freed up after a manual move).
 */
export async function bulkAssignRoomsByFloor({ req, actor, paketId, floor }) {
  if (!paketId) throw new HttpError(400, 'paketId wajib', 'BAD_INPUT');
  if (floor == null || floor === '') throw new HttpError(400, 'floor wajib', 'BAD_INPUT');
  const floorNum = Number(floor);
  if (!Number.isFinite(floorNum)) {
    throw new HttpError(400, 'floor harus angka', 'BAD_INPUT');
  }

  // Load all unassigned active bookings on this paket, ordered by
  // createdAt asc so the earliest jemaah get first dibs on rooms.
  const unassigned = await db.booking.findMany({
    where: {
      paketId, roomId: null,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, bookingNo: true, kelas: true, paxCount: true },
  });

  // Load all rooms on the requested floor with current occupancy.
  const rooms = await db.room.findMany({
    where: { paketId, floor: floorNum },
    orderBy: { roomNo: 'asc' },
    include: {
      bookings: {
        where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        select: { paxCount: true },
      },
    },
  });
  // Track remaining capacity per room across the batch
  const capLeft = new Map(rooms.map((r) => [
    r.id, { room: r, left: r.capacity - r.bookings.reduce((acc, b) => acc + b.paxCount, 0) },
  ]));

  const assigned = [];
  const skipped = [];
  const errors = [];

  for (const b of unassigned) {
    // First-fit: find a room with matching kelas + enough left capacity
    let pick = null;
    for (const [, info] of capLeft) {
      if (info.room.kelas !== b.kelas) continue;
      if (info.left < b.paxCount) continue;
      pick = info;
      break;
    }
    if (!pick) {
      skipped.push({
        bookingNo: b.bookingNo, kelas: b.kelas, paxCount: b.paxCount,
        reason: 'no_matching_room',
      });
      continue;
    }
    try {
      await db.booking.update({
        where: { id: b.id }, data: { roomId: pick.room.id },
      });
      await audit({
        req, actor,
        action: 'UPDATE', entity: 'Booking', entityId: b.id,
        before: { roomId: null },
        after: {
          roomId: pick.room.id, roomNo: pick.room.roomNo, kelas: pick.room.kelas,
          bulkAssignByFloor: true, floor: floorNum,
        },
      });
      pick.left -= b.paxCount;
      assigned.push({
        bookingNo: b.bookingNo, roomNo: pick.room.roomNo, kelas: b.kelas,
      });
    } catch (err) {
      errors.push({ bookingNo: b.bookingNo, error: err?.message || String(err) });
    }
  }

  return {
    floor: floorNum,
    totalUnassigned: unassigned.length,
    totalRoomsOnFloor: rooms.length,
    assigned, skipped, errors,
  };
}

/**
 * Stage 178 — swap two bookings' room assignments in one transaction.
 * Saves the 4-step manual flow (unassign A, unassign B, reassign each).
 *
 * Both bookings stay on the same paket — cross-paket swap doesn't
 * make operational sense and would muddy the audit trail. Capacity
 * is validated symmetrically: after the swap, neither destination
 * room should overflow.
 *
 * Edge cases:
 *   - One booking has no room → "swap" promotes the other to its
 *     emptied slot (handled by the symmetric assignment).
 *   - Same kelas required (mirrors single-assign rule).
 *   - Booking with status CANCELLED/REFUNDED rejected (closed
 *     bookings shouldn't be touched).
 *   - No-op (same room) returns without writing.
 */
export async function swapBookingRooms({ req, actor, bookingIdA, bookingIdB }) {
  if (!bookingIdA || !bookingIdB || bookingIdA === bookingIdB) {
    throw new HttpError(400, 'Pilih dua booking yang berbeda', 'BAD_SWAP_PAIR');
  }
  const [a, b] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingIdA },
      select: { id: true, bookingNo: true, status: true, paxCount: true,
        kelas: true, paketId: true, roomId: true },
    }),
    db.booking.findUnique({
      where: { id: bookingIdB },
      select: { id: true, bookingNo: true, status: true, paxCount: true,
        kelas: true, paketId: true, roomId: true },
    }),
  ]);
  if (!a || !b) throw new HttpError(404, 'Salah satu booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (a.paketId !== b.paketId) {
    throw new HttpError(400, 'Booking ada di paket berbeda — swap hanya antar booking pada paket yang sama', 'PAKET_MISMATCH');
  }
  for (const x of [a, b]) {
    if (x.status === 'CANCELLED' || x.status === 'REFUNDED') {
      throw new HttpError(409, `Booking ${x.bookingNo} sudah cancelled/refunded`, 'BOOKING_CLOSED');
    }
  }
  if (a.roomId === b.roomId) {
    // Both in the same room (or both unassigned) → swap is a no-op
    return { swapped: false, reason: 'same_room' };
  }

  // Load destination rooms + their current occupants. After swap, A
  // goes to roomB and vice versa.
  const [roomA, roomB] = await Promise.all([
    a.roomId
      ? db.room.findUnique({
          where: { id: a.roomId },
          include: {
            bookings: {
              where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
              select: { id: true, paxCount: true },
            },
          },
        })
      : null,
    b.roomId
      ? db.room.findUnique({
          where: { id: b.roomId },
          include: {
            bookings: {
              where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
              select: { id: true, paxCount: true },
            },
          },
        })
      : null,
  ]);

  // Validate kelas on the destination of each booking.
  if (roomB && a.kelas !== roomB.kelas) {
    throw new HttpError(409,
      `Booking ${a.bookingNo} kelas ${a.kelas} tidak cocok dengan kamar ${roomB.roomNo} (${roomB.kelas})`,
      'KELAS_MISMATCH');
  }
  if (roomA && b.kelas !== roomA.kelas) {
    throw new HttpError(409,
      `Booking ${b.bookingNo} kelas ${b.kelas} tidak cocok dengan kamar ${roomA.roomNo} (${roomA.kelas})`,
      'KELAS_MISMATCH');
  }

  // Capacity check — count occupants of each destination room
  // EXCLUDING the two bookings being swapped (they cancel each other).
  const occupancyAfter = (room, incoming) => {
    if (!room) return 0;
    const others = room.bookings.filter(
      (x) => x.id !== a.id && x.id !== b.id,
    ).reduce((acc, x) => acc + x.paxCount, 0);
    return others + incoming;
  };
  if (roomB && occupancyAfter(roomB, a.paxCount) > roomB.capacity) {
    throw new HttpError(409,
      `Setelah swap, kamar ${roomB.roomNo} akan over-kapasitas`,
      'CAPACITY_EXCEEDED');
  }
  if (roomA && occupancyAfter(roomA, b.paxCount) > roomA.capacity) {
    throw new HttpError(409,
      `Setelah swap, kamar ${roomA.roomNo} akan over-kapasitas`,
      'CAPACITY_EXCEEDED');
  }

  await db.$transaction(async (tx) => {
    // Two-phase swap to avoid hitting any per-row constraint mid-swap:
    // 1) detach A
    await tx.booking.update({ where: { id: a.id }, data: { roomId: null } });
    // 2) attach B to A's old room
    await tx.booking.update({ where: { id: b.id }, data: { roomId: a.roomId } });
    // 3) attach A to B's old room
    await tx.booking.update({ where: { id: a.id }, data: { roomId: b.roomId } });
  });

  // One audit row per booking — the timeline filter on
  // /admin/bookings/:id picks both up under the booking's own thread.
  await Promise.all([
    audit({
      req, actor, action: 'UPDATE', entity: 'Booking', entityId: a.id,
      before: { roomId: a.roomId },
      after: { roomId: b.roomId, swap: true, swappedWith: b.bookingNo },
    }),
    audit({
      req, actor, action: 'UPDATE', entity: 'Booking', entityId: b.id,
      before: { roomId: b.roomId },
      after: { roomId: a.roomId, swap: true, swappedWith: a.bookingNo },
    }),
  ]);

  return {
    swapped: true,
    a: { id: a.id, bookingNo: a.bookingNo, newRoomId: b.roomId },
    b: { id: b.id, bookingNo: b.bookingNo, newRoomId: a.roomId },
  };
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
