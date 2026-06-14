// Stage 280 — admin booking handover. Replaces the jemaah on an
// existing booking while preserving everything else (paket, kelas,
// money, agent, room, pickup, notes, group). Used when a jemaah
// can't go and sells/transfers their slot to a relative — the trip
// itself shouldn't lose its paid balance just because the person
// changed.
//
// Distinct from:
//   - S256 cloneBooking — creates a NEW booking on the same paket
//     (when two family members both want to go).
//   - S21 transferBookingAgent — changes the SERVICING agent, not
//     the jemaah.
//
// Status-tier authorization:
//   PENDING / BOOKED / DP_PAID  → any CANCEL_ROLES
//   PARTIAL                      → OWNER + SUPERADMIN only
//   LUNAS                        → OWNER only + explicit ack flag
//   CANCELLED / REFUNDED         → refused (frozen)
//
// Why the tier: the more money has moved, the harder to undo. A
// handover on a PENDING booking is paperwork; on a LUNAS booking
// it's effectively reassigning the seat someone paid for fully.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const ANY_ADMIN_ROLES = new Set(['OWNER', 'SUPERADMIN', 'MANAJER_OPS']);
const STRICT_ROLES = new Set(['OWNER', 'SUPERADMIN']);
const OWNER_ONLY = new Set(['OWNER']);

/**
 * Resolve which roles may handover a booking in this status.
 * Returns an object {allowed: Set, needsAck: boolean}.
 */
export function resolveHandoverAuthz(status) {
  switch (status) {
    case 'PENDING':
    case 'BOOKED':
    case 'DP_PAID':
      return { allowed: ANY_ADMIN_ROLES, needsAck: false };
    case 'PARTIAL':
      return { allowed: STRICT_ROLES, needsAck: false };
    case 'LUNAS':
      return { allowed: OWNER_ONLY, needsAck: true };
    default:
      // CANCELLED / REFUNDED / anything else → handover refused at the
      // status-check layer below before reaching authz.
      return { allowed: new Set(), needsAck: false };
  }
}

/**
 * Stage 282 — pull handover lineage for a booking from audit log.
 * Returns an array of `{at, previousJemaahId, previousJemaahName,
 * previousJemaahPhone, newJemaahId, newJemaahName, reason,
 * bookingStatusAtHandover, actorEmail}`, newest first.
 *
 * Reads from AuditLog (entity=Booking, after.handover=true) — handover
 * already writes the full lineage there, so no separate table needed.
 */
export async function getBookingHandoverLineage(bookingId) {
  if (!bookingId) return [];
  // MariaDB JSON path filter — use `$.handover` not `path: ['handover']`
  // (per CLAUDE.md MySQL-vs-Postgres path convention).
  const rows = await db.auditLog.findMany({
    where: {
      entity: 'Booking',
      entityId: bookingId,
      action: 'UPDATE',
      after: { path: '$.handover', equals: true },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, createdAt: true,
      actorEmail: true, actorRole: true,
      before: true, after: true,
    },
  });
  return rows.map((r) => ({
    auditId: r.id,
    at: r.createdAt,
    actorEmail: r.actorEmail,
    actorRole: r.actorRole,
    reason: r.after?.reason || null,
    bookingStatusAtHandover: r.after?.bookingStatusAtHandover || null,
    acknowledgedLunas: !!r.after?.acknowledgedLunas,
    previousJemaahId: r.after?.previousJemaahId || r.before?.jemaahId || null,
    previousJemaahName: r.after?.previousJemaahName || r.before?.jemaahName || null,
    previousJemaahPhone: r.after?.previousJemaahPhone || r.before?.jemaahPhone || null,
    newJemaahId: r.after?.newJemaahId || null,
    newJemaahName: r.after?.newJemaahName || null,
    newJemaahPhone: r.after?.newJemaahPhone || null,
  }));
}

/**
 * Replace the jemaah on a booking.
 *
 * @param {object} opts
 * @param {object} opts.req
 * @param {object} opts.actor — admin actor
 * @param {string} opts.bookingId
 * @param {object} opts.newJemaah — `{fullName, phone, email?, nik?}`
 * @param {string} opts.reason — min 3 chars; admin must justify
 * @param {boolean} [opts.acknowledgeLunas] — required on LUNAS bookings
 */
export async function handoverBookingJemaah({ req, actor, bookingId, newJemaah = {}, reason, acknowledgeLunas = false }) {
  if (!bookingId) {
    throw new HttpError(400, 'Booking ID wajib', 'BOOKING_ID_REQUIRED');
  }
  if (!newJemaah?.fullName || newJemaah.fullName.trim().length < 2) {
    throw new HttpError(400, 'Nama jemaah baru wajib (min. 2 karakter)', 'JEMAAH_NAME_REQUIRED');
  }
  if (!newJemaah?.phone || newJemaah.phone.trim().length < 4) {
    throw new HttpError(400, 'Telepon jemaah baru wajib', 'JEMAAH_PHONE_REQUIRED');
  }
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan handover wajib (min. 3 karakter)', 'HANDOVER_REASON_REQUIRED');
  }

  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, paketId: true,
      jemaahId: true, jemaahUserId: true,
      jemaah: { select: { id: true, fullName: true, phone: true, email: true, userId: true } },
    },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — handover tidak diizinkan', 'BOOKING_CLOSED');
  }

  const authz = resolveHandoverAuthz(before.status);
  if (!authz.allowed.has(actor?.role)) {
    throw new HttpError(403,
      `Status ${before.status}: hanya role ${[...authz.allowed].join('/')} yang boleh handover`,
      'HANDOVER_ROLE_FORBIDDEN');
  }
  if (authz.needsAck && !acknowledgeLunas) {
    throw new HttpError(409,
      'Handover di status LUNAS wajib acknowledge: uang sudah lunas, perubahan jemaah harus konfirmasi tertulis',
      'HANDOVER_LUNAS_NEEDS_ACK');
  }

  // Same-jemaah no-op: if newJemaah matches current name+phone, refuse
  // (almost certainly admin error — handover always changes the person).
  if (
    before.jemaah?.fullName?.trim().toLowerCase() === newJemaah.fullName.trim().toLowerCase()
    && before.jemaah?.phone?.replace(/\D/g, '') === newJemaah.phone.replace(/\D/g, '')
  ) {
    throw new HttpError(409, 'Identitas jemaah baru sama dengan jemaah saat ini', 'HANDOVER_NO_OP');
  }

  const result = await db.$transaction(async (tx) => {
    // Create the new JemaahProfile inline (matches walk-in booking +
    // S256 clone pattern — handover always spawns a fresh profile so
    // there's no implicit merge with existing accounts).
    const newProfile = await tx.jemaahProfile.create({
      data: {
        fullName: newJemaah.fullName.trim(),
        phone: newJemaah.phone.trim(),
        email: newJemaah.email?.trim() || null,
        nik: newJemaah.nik?.trim() || null,
      },
    });

    // Re-point booking. jemaahUserId is cleared because the new profile
    // is unattached to any user account (claim flow handles that if the
    // new jemaah later registers + claims via bookingNo+phone).
    const updated = await tx.booking.update({
      where: { id: before.id },
      data: { jemaahId: newProfile.id, jemaahUserId: null },
      select: { id: true, bookingNo: true, status: true, jemaahId: true },
    });

    return { newProfile, updated };
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: before.id,
    before: {
      jemaahId: before.jemaahId,
      jemaahName: before.jemaah?.fullName,
      jemaahPhone: before.jemaah?.phone,
      jemaahUserId: before.jemaahUserId,
    },
    after: {
      handover: true,
      reason: reason.trim(),
      bookingStatusAtHandover: before.status,
      acknowledgedLunas: !!(authz.needsAck && acknowledgeLunas),
      newJemaahId: result.newProfile.id,
      newJemaahName: result.newProfile.fullName,
      newJemaahPhone: result.newProfile.phone,
      previousJemaahId: before.jemaahId,
      previousJemaahName: before.jemaah?.fullName,
      previousJemaahPhone: before.jemaah?.phone,
    },
  });

  // Stage 281 — best-effort notif fan-out (both old + new jemaah).
  // Notif failure must NOT abort the handover — the swap already
  // landed in DB.
  try {
    const { notifyBookingHandover } = await import('./notifications.js');
    await notifyBookingHandover({
      booking: { id: before.id, bookingNo: before.bookingNo },
      previousJemaah: {
        id: before.jemaahId,
        fullName: before.jemaah?.fullName,
        phone: before.jemaah?.phone,
        email: before.jemaah?.email,
        userId: before.jemaah?.userId,
      },
      newJemaah: {
        id: result.newProfile.id,
        fullName: result.newProfile.fullName,
        phone: result.newProfile.phone,
        email: result.newProfile.email,
      },
      reason: reason.trim(),
      adminEmail: actor?.email,
    });
  } catch (err) {
    console.warn('[handoverBookingJemaah] notif failed:', err?.message || err);
  }

  return {
    booking: result.updated,
    newJemaah: result.newProfile,
    previousJemaah: {
      id: before.jemaahId,
      fullName: before.jemaah?.fullName,
      phone: before.jemaah?.phone,
      email: before.jemaah?.email,
      userId: before.jemaah?.userId,
    },
  };
}
