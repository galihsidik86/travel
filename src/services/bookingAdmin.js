import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export async function getBookingById(id) {
  const booking = await db.booking.findUnique({
    where: { id },
    include: {
      paket: { select: { id: true, slug: true, title: true, departureDate: true, returnDate: true } },
      jemaah: {
        include: {
          documents: { orderBy: { type: 'asc' } },
        },
      },
      agent: { select: { id: true, slug: true, displayName: true, whatsapp: true } },
      room: { select: { id: true, roomNo: true, floor: true, wing: true, capacity: true } },
      payments: { orderBy: { createdAt: 'desc' } },
      komisi: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!booking) return null;

  // Audit history for this booking (entity=Booking, entityId=this)
  const history = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, action: true, actorEmail: true, actorRole: true,
      before: true, after: true, ip: true, createdAt: true,
    },
  });

  return { ...booking, history };
}

/**
 * Update a booking's free-text notes. Idempotent; safe to call repeatedly.
 *   - Trims whitespace; empty string is stored as null.
 *   - Caps at 2000 chars (silently truncates above that — caller should
 *     enforce this in the UI as well).
 *   - Skips DB write + audit if the value didn't actually change.
 */
export async function updateBookingNotes({ req, actor, bookingId, notes }) {
  const cleaned = (notes ?? '').toString().trim().slice(0, 2000);
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, notes: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');

  const next = cleaned === '' ? null : cleaned;
  if ((before.notes ?? null) === next) {
    return before; // no-op — don't pollute audit log
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { notes: next },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { notes: before.notes },
    after: { notes: next, field: 'notes' },
  });
  return updated;
}

/**
 * Transfer a booking from one agent to another (or to Kantor Pusat / no agent).
 *
 * Invariants:
 *   - `agentSlugCap` is NEVER touched — that's the historical URL trail, which
 *     stays put as audit evidence of where the visitor originally came from.
 *   - Booking must be active (not CANCELLED/REFUNDED).
 *   - If toAgentId equals current agentId, no-op (returns booking unchanged).
 *   - Komisi handling per status:
 *       PENDING   → re-point to toAgent (if not null) or DELETE (Kantor Pusat doesn't get komisi)
 *       EARNED    → opt-in via `includeEarnedKomisi` flag (default: stay with original agent
 *                   because they earned it; admin can transfer if appropriate)
 *       PAID      → never touch (already disbursed)
 *       CANCELLED → never touch (history)
 *
 * Audit summary includes: from/to agent id+slug, reason, komisi action counts.
 */
export async function transferBookingAgent({ req, actor, bookingId, toAgentId, reason, includeEarnedKomisi = false }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan transfer wajib diisi (min. 3 karakter)', 'TRANSFER_REASON_REQUIRED');
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, agentId: true, agentSlugCap: true,
      komisi: { select: { id: true, status: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa transfer', 'BOOKING_CLOSED');
  }
  const normalizedTo = toAgentId || null;
  if (normalizedTo === booking.agentId) {
    return { booking, noop: true };
  }

  let toAgent = null;
  if (normalizedTo) {
    toAgent = await db.agentProfile.findUnique({
      where: { id: normalizedTo },
      select: { id: true, slug: true, displayName: true },
    });
    if (!toAgent) throw new HttpError(404, 'Agen tujuan tidak ditemukan', 'AGENT_NOT_FOUND');
  }

  // Classify komisi
  const pending = booking.komisi.filter((k) => k.status === 'PENDING');
  const earned = booking.komisi.filter((k) => k.status === 'EARNED');
  const pendingIds = pending.map((k) => k.id);
  const earnedIds = earned.map((k) => k.id);

  let pendingMoved = 0, pendingDeleted = 0, earnedMoved = 0;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.booking.update({
      where: { id: bookingId },
      data: { agentId: normalizedTo },
    });

    // PENDING komisi: move or delete
    if (pendingIds.length > 0) {
      if (normalizedTo) {
        const r = await tx.komisi.updateMany({
          where: { id: { in: pendingIds } },
          data: { agentId: normalizedTo },
        });
        pendingMoved = r.count;
      } else {
        const r = await tx.komisi.deleteMany({ where: { id: { in: pendingIds } } });
        pendingDeleted = r.count;
      }
    }

    // EARNED komisi: opt-in transfer (otherwise stays with original agent)
    if (includeEarnedKomisi && earnedIds.length > 0 && normalizedTo) {
      const r = await tx.komisi.updateMany({
        where: { id: { in: earnedIds } },
        data: { agentId: normalizedTo },
      });
      earnedMoved = r.count;
    }

    return u;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: {
      agentId: booking.agentId,
      agentSlug: booking.agent?.slug ?? null,
    },
    after: {
      agentId: normalizedTo,
      agentSlug: toAgent?.slug ?? null,
      agentDisplayName: toAgent?.displayName ?? '— Kantor Pusat —',
      agentSlugCap: booking.agentSlugCap, // unchanged — emphasised in audit
      transfer: true,
      reason: reason.trim(),
      komisi: {
        pendingMoved, pendingDeleted, earnedMoved,
        earnedKept: earned.length - earnedMoved,
      },
    },
  });

  return { booking: updated, noop: false, fromAgent: booking.agent, toAgent };
}

/**
 * Cancel a booking.
 *   - Refuses if already CANCELLED/REFUNDED
 *   - Sets status=CANCELLED + cancelledAt + cancelReason
 *   - Decrements Paket.kursiTerisi by paxCount (frees the seat back)
 *   - Unassigns from room (roomId=null)
 *   - Cancels any EARNED komisi (status=CANCELLED) — leaves PAID alone (already disbursed)
 *   - Audit row
 *
 * Note: Payment rows are NOT touched. Refund is a separate flow (5k.x).
 */
export async function cancelBooking({ req, actor, bookingId, reason }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan pembatalan wajib diisi (min. 3 karakter)', 'CANCEL_REASON_REQUIRED');
  }
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, paxCount: true,
      paketId: true, roomId: true, agentId: true,
      paidAmount: true, totalAmount: true,
    },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'ALREADY_CLOSED');
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
        roomId: null,
        // Clear any pending jemaah request now that admin acted (5ff)
        cancelRequested: false,
        cancelRequestedAt: null,
        cancelRequestReason: null,
      },
    });
    // Free seats back to pool
    await tx.paket.update({
      where: { id: before.paketId },
      data: { kursiTerisi: { decrement: before.paxCount } },
    });
    // Cancel EARNED komisi (PAID is already disbursed — keep history)
    await tx.komisi.updateMany({
      where: { bookingId, status: 'EARNED' },
      data: { status: 'CANCELLED' },
    });
    return u;
  });

  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: { status: before.status, roomId: before.roomId, paidAmount: Number(before.paidAmount) },
    after: { status: 'CANCELLED', cancelReason: reason.trim(), kursiFreed: before.paxCount },
  });

  return updated;
}
