// Stage 295 + 296 — per-booking discount/surcharge adjustment.
//
// Mutates Booking.totalAmount in the same transaction so the existing
// money flow stays correct without changes. Distinct from S145/S235
// refund (post-cancel only) and from S284 BookingAddon (positive line
// item, not a price tweak).
//
// Reason codes (S296) are a service-side allowlist (not a DB enum)
// so future additions don't need migrations.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

// Stage 296 — reason code allowlist. Order matters for the UI dropdown.
export const ADJUSTMENT_REASON_CODES = [
  'LOYALTY',     // returning-customer discount
  'PROMO',       // marketing campaign / seasonal promo
  'GROUP',       // family / corporate group rebate
  'STAFF',       // internal pricing (staff family / partner)
  'GOODWILL',    // compensation for service issue
  'CORRECTION', // fix a quoting / pricing mistake
  'OTHER',
];

const REASON_CODE_SET = new Set(ADJUSTMENT_REASON_CODES);

function n(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

function normaliseReasonCode(raw) {
  if (!raw) return null;
  const c = String(raw).trim().toUpperCase();
  return REASON_CODE_SET.has(c) ? c : null;
}

/**
 * Add a discount/surcharge to a booking.
 *   - `kind`: 'DISCOUNT' (subtract) | 'SURCHARGE' (add)
 *   - `amountIdr`: positive integer Rupiah (sign comes from `kind`)
 *   - `reasonCode`: must be in ADJUSTMENT_REASON_CODES
 *   - `reasonNote`: optional free text (max 500 chars)
 *
 * Refuses:
 *   - CANCELLED/REFUNDED bookings (frozen state) → BOOKING_CLOSED 409
 *   - missing/zero amount → ADJUSTMENT_BAD_AMOUNT 400
 *   - unknown reasonCode → ADJUSTMENT_BAD_REASON 400
 *   - DISCOUNT that would push totalAmount below paidAmount (refund-territory)
 *     → ADJUSTMENT_BELOW_PAID 409 (admin must refund first, then discount)
 *
 * Audit row carries kind + amount + reason + before/after totalAmount.
 */
export async function addBookingAdjustment({ req, actor, bookingId, kind, amountIdr, reasonCode, reasonNote }) {
  if (!bookingId) throw new HttpError(400, 'Booking ID wajib', 'BOOKING_ID_REQUIRED');
  const kindNorm = String(kind || '').toUpperCase();
  if (kindNorm !== 'DISCOUNT' && kindNorm !== 'SURCHARGE') {
    throw new HttpError(400, 'Kind harus DISCOUNT atau SURCHARGE', 'ADJUSTMENT_BAD_KIND');
  }
  const amt = Math.round(n(amountIdr));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new HttpError(400, 'Amount harus angka > 0', 'ADJUSTMENT_BAD_AMOUNT');
  }
  const code = normaliseReasonCode(reasonCode);
  if (!code) {
    throw new HttpError(400,
      `Reason code wajib salah satu dari: ${ADJUSTMENT_REASON_CODES.join(', ')}`,
      'ADJUSTMENT_BAD_REASON');
  }
  const note = reasonNote ? String(reasonNote).trim().slice(0, 500) || null : null;

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, totalAmount: true, paidAmount: true },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa adjust', 'BOOKING_CLOSED');
  }

  const oldTotal = n(booking.totalAmount);
  const paid = n(booking.paidAmount);
  const delta = kindNorm === 'DISCOUNT' ? -amt : amt;
  const newTotal = oldTotal + delta;

  // Discount can't push total below already-paid (would mean refund territory)
  if (newTotal < paid) {
    throw new HttpError(409,
      `Discount Rp ${amt.toLocaleString('id-ID')} membuat total (${newTotal.toLocaleString('id-ID')}) di bawah yang sudah dibayar (${paid.toLocaleString('id-ID')}). Issue refund dulu jika perlu kembalikan uang.`,
      'ADJUSTMENT_BELOW_PAID');
  }
  if (newTotal < 0) {
    throw new HttpError(409, 'Adjustment membuat total negatif', 'ADJUSTMENT_NEGATIVE_TOTAL');
  }

  const adjustment = await db.$transaction(async (tx) => {
    const row = await tx.bookingAdjustment.create({
      data: {
        bookingId, kind: kindNorm,
        amountIdr: amt.toFixed(2),
        reasonCode: code,
        reasonNote: note,
        createdByEmail: actor?.email || null,
      },
    });
    await tx.booking.update({
      where: { id: bookingId },
      data: { totalAmount: newTotal.toFixed(2) },
    });
    return row;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { totalAmount: oldTotal },
    after: {
      totalAmount: newTotal,
      adjustmentAdded: true,
      adjustmentId: adjustment.id,
      kind: kindNorm,
      amountIdr: amt,
      reasonCode: code,
      reasonNote: note,
      delta,
    },
  });

  return { adjustment, oldTotal, newTotal };
}

/**
 * Remove an adjustment. Reverses the totalAmount mutation in the same
 * transaction. Same status guards as add.
 */
export async function removeBookingAdjustment({ req, actor, bookingId, adjustmentId }) {
  if (!bookingId || !adjustmentId) {
    throw new HttpError(400, 'bookingId + adjustmentId wajib', 'IDS_REQUIRED');
  }
  const [booking, adj] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, totalAmount: true, paidAmount: true },
    }),
    db.bookingAdjustment.findUnique({
      where: { id: adjustmentId },
      select: { id: true, bookingId: true, kind: true, amountIdr: true, reasonCode: true },
    }),
  ]);
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (!adj) throw new HttpError(404, 'Adjustment tidak ditemukan', 'ADJUSTMENT_NOT_FOUND');
  if (adj.bookingId !== bookingId) {
    throw new HttpError(409, 'Mismatched booking/adjustment pair', 'BA_BOOKING_MISMATCH');
  }
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }

  // Reverse the delta — DISCOUNT subtracted so removal ADDS back; SURCHARGE added so removal subtracts
  const amt = Math.round(n(adj.amountIdr));
  const reverseDelta = adj.kind === 'DISCOUNT' ? +amt : -amt;
  const oldTotal = n(booking.totalAmount);
  const newTotal = oldTotal + reverseDelta;

  if (newTotal < n(booking.paidAmount)) {
    throw new HttpError(409,
      'Menghapus adjustment ini akan membuat total di bawah yang sudah dibayar. Issue refund dulu.',
      'ADJUSTMENT_BELOW_PAID');
  }
  if (newTotal < 0) {
    throw new HttpError(409, 'Penghapusan adjustment membuat total negatif', 'ADJUSTMENT_NEGATIVE_TOTAL');
  }

  await db.$transaction(async (tx) => {
    await tx.bookingAdjustment.delete({ where: { id: adjustmentId } });
    await tx.booking.update({
      where: { id: bookingId },
      data: { totalAmount: newTotal.toFixed(2) },
    });
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { totalAmount: oldTotal },
    after: {
      totalAmount: newTotal,
      adjustmentRemoved: true,
      adjustmentId, kind: adj.kind,
      amountIdr: amt, reasonCode: adj.reasonCode,
      reverseDelta,
    },
  });

  return { removed: true, oldTotal, newTotal };
}

/** List adjustments on a booking (for view rendering). */
export async function listBookingAdjustments(bookingId) {
  return db.bookingAdjustment.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
  });
}
