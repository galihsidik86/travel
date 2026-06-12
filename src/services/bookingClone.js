// Stage 256 — admin clones a booking for a new jemaah on the same paket.
// Typical use case: family booking, mahram pair, company group. The
// clone inherits paket / kelas / paxCount / agen / notes prefix from
// the source so admin doesn't re-enter shared fields.
//
// Group key (S257):
//   - If source has a groupKey, the clone inherits it (existing group).
//   - If source has NO groupKey, the clone-action also stamps the
//     source with a freshly-generated key — creating the group on the
//     fly. Both bookings now share the key.
//
// Clone does NOT carry over:
//   - paidAmount (always 0 on clone — different jemaah, different money)
//   - cancel/refund/no-show fields (frozen state shouldn't carry)
//   - tags / autoTaggedSeen / pickupId / roomId (those are per-jemaah)
//   - visitor attribution / first view / komisi (those are per-booking)
//
// Uses the canonical createBooking flow indirectly only for the notif
// + webhook side effects — we still do a direct insert here because
// createBooking expects a public-form shape. Audit row carries
// `clonedFromBookingId` so the lineage is queryable.

import { randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const BOOKING_NO_PREFIX = 'RP';

function generateGroupKey() {
  // 6-char base36 — short enough to type if needed, unique enough at scale
  return `G-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

async function nextBookingNo() {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const count = await db.booking.count({
      where: { bookingNo: { startsWith: `${BOOKING_NO_PREFIX}-${year}-` } },
    });
    const seq = String(count + 1 + attempt).padStart(5, '0');
    const candidate = `${BOOKING_NO_PREFIX}-${year}-${seq}`;
    const existing = await db.booking.findUnique({ where: { bookingNo: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new HttpError(500, 'Gagal generate booking number', 'BOOKING_NO_COLLISION');
}

/**
 * Clone an existing booking onto a NEW jemaah profile (just created
 * inline from `newJemaah` form input). The source booking is preserved
 * untouched (except for inheriting a fresh groupKey when it had none).
 *
 * Returns `{ booking, groupKey, groupCreated }`.
 */
export async function cloneBooking({
  req, actor, sourceBookingId,
  newJemaah = {},      // { fullName, phone, email?, nik? }
  paxCount,            // optional override; defaults to source.paxCount
  notesPrefix,         // optional admin-added note appended to source.notes
}) {
  if (!sourceBookingId) {
    throw new HttpError(400, 'Source booking ID wajib', 'SOURCE_REQUIRED');
  }
  if (!newJemaah?.fullName || newJemaah.fullName.trim().length < 2) {
    throw new HttpError(400, 'Nama jemaah baru wajib (min. 2 karakter)', 'JEMAAH_NAME_REQUIRED');
  }
  if (!newJemaah?.phone || newJemaah.phone.trim().length < 4) {
    throw new HttpError(400, 'Telepon jemaah baru wajib', 'JEMAAH_PHONE_REQUIRED');
  }

  const source = await db.booking.findUnique({
    where: { id: sourceBookingId },
    select: {
      id: true, bookingNo: true, paketId: true, agentId: true, agentSlugCap: true,
      kelas: true, paxCount: true, totalAmount: true, currency: true, notes: true,
      status: true, groupKey: true,
      paket: { select: { id: true, slug: true, title: true, kursiTotal: true, kursiTerisi: true } },
    },
  });
  if (!source) throw new HttpError(404, 'Source booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (source.status === 'CANCELLED' || source.status === 'REFUNDED') {
    throw new HttpError(409, 'Source booking sudah cancelled/refunded — pilih booking aktif', 'SOURCE_CLOSED');
  }
  // Capacity check — source paket must still have seats
  const reqPax = paxCount && paxCount > 0 ? paxCount : source.paxCount;
  const seatsLeft = source.paket.kursiTotal - source.paket.kursiTerisi;
  if (reqPax > seatsLeft) {
    throw new HttpError(409,
      `Kursi tidak cukup (butuh ${reqPax}, tersisa ${seatsLeft})`,
      'NOT_ENOUGH_SEATS');
  }

  // Group key resolution
  let groupKey = source.groupKey;
  let groupCreated = false;
  if (!groupKey) {
    groupKey = generateGroupKey();
    groupCreated = true;
  }

  const result = await db.$transaction(async (tx) => {
    // Create the new jemaah profile inline (mirrors walk-in booking flow)
    const newProfile = await tx.jemaahProfile.create({
      data: {
        fullName: newJemaah.fullName.trim(),
        phone: newJemaah.phone.trim(),
        email: newJemaah.email?.trim() || null,
        nik: newJemaah.nik?.trim() || null,
      },
    });

    // Per-pax total from source's totalAmount (avg per pax × new paxCount)
    const sourceTotal = Number(source.totalAmount?.toString?.() ?? source.totalAmount) || 0;
    const perPax = source.paxCount > 0 ? sourceTotal / source.paxCount : 0;
    const newTotal = Math.round(perPax * reqPax);

    const bookingNo = await nextBookingNo();
    const clonedNotes = [
      `[Cloned from ${source.bookingNo}]`,
      notesPrefix ? notesPrefix.trim() : null,
      source.notes ? `--- Source notes ---\n${source.notes}` : null,
    ].filter(Boolean).join('\n\n');

    const clone = await tx.booking.create({
      data: {
        bookingNo,
        paketId: source.paketId,
        jemaahId: newProfile.id,
        agentId: source.agentId,
        agentSlugCap: source.agentSlugCap,
        kelas: source.kelas,
        paxCount: reqPax,
        totalAmount: String(newTotal),
        paidAmount: '0',
        currency: source.currency,
        status: 'PENDING',
        notes: clonedNotes,
        groupKey,
      },
    });

    // Stamp the source with the same groupKey if it had none
    if (groupCreated) {
      await tx.booking.update({
        where: { id: source.id },
        data: { groupKey },
      });
    }

    // Bump paket seat count by the new booking's pax
    await tx.paket.update({
      where: { id: source.paketId },
      data: { kursiTerisi: { increment: reqPax } },
    });

    return { newProfile, clone };
  });

  await audit({
    req, actor,
    action: 'CREATE', entity: 'Booking', entityId: result.clone.id,
    after: {
      bookingNo: result.clone.bookingNo,
      clonedFromBookingId: source.id,
      clonedFromBookingNo: source.bookingNo,
      groupKey,
      groupCreated,
      paxCount: reqPax,
    },
  });

  if (groupCreated) {
    await audit({
      req, actor,
      action: 'UPDATE', entity: 'Booking', entityId: source.id,
      before: { groupKey: null },
      after: { groupKey, groupKeyAssignedFromClone: true, clonedToBookingId: result.clone.id },
    });
  }

  return { booking: result.clone, groupKey, groupCreated };
}

export { generateGroupKey };
