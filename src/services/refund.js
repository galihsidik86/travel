import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { toNumber } from '../lib/format.js';
import { notifyRefundIssued } from './notifications.js';

const METHODS = new Set(['VA', 'QRIS', 'EWALLET', 'CARD', 'TRANSFER', 'CASH']);

/**
 * Issue a refund against a CANCELLED booking.
 *   - Creates a new Payment row with negative `amount` and status=REFUNDED
 *     (Payment is treated as append-only — never mutate the original PAID rows).
 *   - Decrements Booking.paidAmount by `amount`.
 *   - When paidAmount reaches 0, transitions Booking.status to REFUNDED (terminal).
 *   - Repeatable: multiple partial refunds OK as long as sum ≤ original paidAmount.
 *
 * Validation:
 *   - Booking must exist and be in CANCELLED state (cancel first, then refund).
 *   - amount > 0 and ≤ current paidAmount.
 *   - method ∈ PaymentMethod enum.
 */
export async function issueRefund({ req, actor, bookingId, amount, method, reason, acknowledgeNoShow = false }) {
  if (!METHODS.has(method)) {
    throw new HttpError(400, 'Metode refund tidak valid', 'INVALID_METHOD');
  }
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan refund wajib (min. 3 karakter)', 'REFUND_REASON_REQUIRED');
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new HttpError(400, 'Jumlah refund harus > 0', 'INVALID_AMOUNT');
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, paidAmount: true, noShowAt: true },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');

  if (booking.status !== 'CANCELLED') {
    throw new HttpError(409,
      `Refund hanya bisa untuk booking CANCELLED — status saat ini ${booking.status}. Cancel dulu, lalu refund.`,
      'BOOKING_NOT_CANCELLED');
  }

  const currentPaid = toNumber(booking.paidAmount) ?? 0;
  if (currentPaid <= 0) {
    throw new HttpError(409, 'Tidak ada nominal yang bisa di-refund (paidAmount = 0)', 'NOTHING_TO_REFUND');
  }
  if (amt > currentPaid) {
    throw new HttpError(409,
      `Jumlah refund (${amt.toLocaleString('id-ID')}) melebihi sisa paid (${currentPaid.toLocaleString('id-ID')})`,
      'REFUND_EXCEEDS_PAID');
  }

  // Stage 145 — no-show guard. A booking that was flagged as no-show
  // already had the seat lost AND the jemaah didn't fly with us — they
  // may have flown with a competitor (we wouldn't know). Refusing the
  // default-100% refund forces admin to acknowledge the context before
  // money goes back. Partial refunds are still allowed without ack
  // (sometimes a goodwill 50% is the right call); only the full
  // current-paid refund triggers the guard.
  //
  // Caller passes `acknowledgeNoShow: true` after seeing the warning
  // in the UI. Audit row carries the ack flag so the decision is
  // traceable downstream.
  if (booking.noShowAt && amt >= currentPaid && !acknowledgeNoShow) {
    throw new HttpError(409,
      `Booking ini ter-flag no-show (${booking.noShowAt.toISOString().slice(0,10)}). ` +
      `Konfirmasi dulu apakah jemaah benar-benar layak refund penuh — mungkin terbang dengan operator lain.`,
      'NOSHOW_REFUND_NEEDS_ACK');
  }

  const newPaid = currentPaid - amt;
  const newStatus = newPaid === 0 ? 'REFUNDED' : 'CANCELLED'; // stay CANCELLED on partial

  const { payment, updatedBooking } = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        bookingId,
        amount: (-amt).toFixed(2), // negative — refund out
        currency: 'IDR',
        method,
        status: 'REFUNDED',
        paidAt: new Date(),
        notes: reason.trim(),
      },
    });
    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        paidAmount: newPaid.toFixed(2),
        ...(newStatus !== booking.status ? { status: newStatus } : {}),
      },
    });
    return { payment, updatedBooking };
  });

  await audit({
    req, actor,
    action: 'REFUND_ISSUED',
    entity: 'Booking',
    entityId: bookingId,
    before: { status: booking.status, paidAmount: currentPaid },
    after: {
      status: newStatus,
      paidAmount: newPaid,
      refundAmount: amt,
      paymentId: payment.id,
      method,
      reason: reason.trim(),
      fullRefund: newPaid === 0,
      // Stage 145 — durable trail of the ack flag when a no-show full
      // refund went through. Lets compliance review "did we knowingly
      // refund all the no-shows last quarter?".
      ...(booking.noShowAt ? { wasNoShow: true, noShowAcknowledged: !!acknowledgeNoShow } : {}),
    },
  });

  // Notif (non-blocking — refund must succeed even if notify fails)
  try {
    const bookingForNotif = await db.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, bookingNo: true, jemaahUserId: true,
        jemaah: { select: { fullName: true, phone: true, email: true, userId: true } } },
    });
    if (bookingForNotif) {
      await notifyRefundIssued({
        booking: bookingForNotif,
        refundAmount: amt,
        fullRefund: newPaid === 0,
        reason: reason.trim(),
      });
    }
  } catch (err) {
    console.error('[refund] notif failed:', err.message);
  }

  // Stage 108 — outbound webhook fan-out.
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    await dispatchEvent('refund.issued', {
      bookingId,
      bookingNo: updatedBooking.bookingNo,
      refundAmount: amt,
      fullRefund: newPaid === 0,
      reason: reason.trim(),
      // S128 — paketId so per-paket subs can filter
      paketId: updatedBooking.paketId,
      bookingStatus: updatedBooking.status,
    });
  } catch (err) {
    console.warn('[refund] webhook dispatch failed:', err?.message || err);
  }

  return { payment, booking: updatedBooking };
}
