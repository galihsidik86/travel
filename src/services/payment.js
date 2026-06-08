import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { toNumber } from '../lib/format.js';
import { notifyPaymentReceived, notifyFirstPaymentThanks } from './notifications.js';

const METHODS = new Set(['VA', 'QRIS', 'EWALLET', 'CARD', 'TRANSFER', 'CASH']);
const CURRENCIES = new Set(['IDR', 'USD', 'SAR']);
const DEFAULT_KOMISI_RATE = 0.06; // safety fallback only — real value lives on Paket.komisiRate (5u)

/**
 * Decide the new BookingStatus given prior status and new paid total.
 * Forward-only: never demotes a booking that's already further along.
 */
export function transitionStatus(prevStatus, paid, total) {
  if (paid <= 0) return prevStatus;
  if (paid >= total) return 'LUNAS';
  // Partial payment in progress
  if (prevStatus === 'PENDING' || prevStatus === 'BOOKED') return 'DP_PAID';
  if (prevStatus === 'DP_PAID') return 'PARTIAL';
  // Already PARTIAL / LUNAS / CANCELLED — leave alone
  return prevStatus;
}

/**
 * Record a payment against an existing booking.
 *   - Creates Payment(status=PAID)
 *   - Increments Booking.paidAmount
 *   - Transitions Booking.status (forward-only)
 *   - On LUNAS transition, creates Komisi(EARNED) for the agent (idempotent)
 *   - Writes audit row (PAYMENT_RECEIVED)
 * Returns { payment, booking, statusChanged, komisi? }.
 */
export async function recordPayment({ req, actor, bookingId, amount, method, currency = 'IDR', notes, gatewayRef, vaNumber }) {
  if (!METHODS.has(method)) throw new HttpError(400, 'Metode pembayaran tidak valid', 'INVALID_METHOD');
  if (!CURRENCIES.has(currency)) throw new HttpError(400, 'Mata uang tidak valid', 'INVALID_CURRENCY');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Jumlah pembayaran harus > 0', 'INVALID_AMOUNT');

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: {
      agent: { select: { id: true, komisiRateOverride: true } },
      paket: { select: { id: true, komisiRate: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa terima pembayaran baru', 'BOOKING_CLOSED');
  }

  const totalAmount = toNumber(booking.totalAmount) ?? 0;
  const currentPaid = toNumber(booking.paidAmount) ?? 0;
  const newPaid = currentPaid + amt;
  const newStatus = transitionStatus(booking.status, newPaid, totalAmount);
  const statusChanged = newStatus !== booking.status;
  const reachedLunas = newStatus === 'LUNAS' && booking.status !== 'LUNAS';

  const { payment, updatedBooking } = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        bookingId: booking.id,
        amount: amt.toFixed(2),
        currency,
        method,
        status: 'PAID',
        paidAt: new Date(),
        gatewayRef: gatewayRef || null,
        vaNumber: vaNumber || null,
        notes: notes || null,
      },
    });
    const updatedBooking = await tx.booking.update({
      where: { id: booking.id },
      data: {
        paidAmount: newPaid.toFixed(2),
        status: newStatus,
        ...(booking.bookingFeeAt == null && currentPaid === 0 ? { bookingFeeAt: new Date() } : {}),
      },
    });
    return { payment, updatedBooking };
  });

  let komisi = null;
  if (reachedLunas && booking.agent?.id) {
    const existing = await db.komisi.findFirst({ where: { bookingId: booking.id } });
    if (!existing) {
      // Precedence (stage 14 → 5v):
      //   AgentPaketKomisi(agentId, paketId).rate   (most specific)
      //   > agent.komisiRateOverride
      //   > paket.komisiRate
      //   > DEFAULT_KOMISI_RATE                     (safety fallback)
      // The rate at this moment is locked into Komisi.amount — never
      // recomputed when these underlying values change later.
      let matrixRate = null;
      if (booking.paket?.id) {
        const matrix = await db.agentPaketKomisi.findUnique({
          where: { agentId_paketId: { agentId: booking.agent.id, paketId: booking.paket.id } },
          select: { rate: true },
        });
        matrixRate = toNumber(matrix?.rate);
      }
      const override = toNumber(booking.agent.komisiRateOverride);
      const paketRate = toNumber(booking.paket?.komisiRate);
      const rate = matrixRate ?? override ?? paketRate ?? DEFAULT_KOMISI_RATE;
      const komisiAmount = Math.round(totalAmount * rate);
      komisi = await db.komisi.create({
        data: {
          bookingId: booking.id,
          agentId: booking.agent.id,
          amount: komisiAmount.toFixed(2),
          currency: 'IDR',
          status: 'EARNED',
          earnedAt: new Date(),
        },
      });
    }
  }

  await audit({
    req,
    actor,
    action: 'PAYMENT_RECEIVED',
    entity: 'Booking',
    entityId: booking.id,
    before: { status: booking.status, paidAmount: currentPaid },
    after: {
      status: newStatus,
      paidAmount: newPaid,
      paymentId: payment.id,
      method,
      currency,
      amount: amt,
      statusChanged,
      komisiCreated: !!komisi,
    },
  });

  // Notif (non-blocking)
  try {
    const bookingForNotif = await db.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, bookingNo: true, jemaahUserId: true,
        jemaah: { select: { fullName: true, phone: true, email: true, userId: true } },
        paket: { select: { title: true, slug: true } } },
    });
    if (bookingForNotif) {
      await notifyPaymentReceived({ booking: bookingForNotif, payment });

      // Stage 75 — when this is the first successful payment on this
      // booking, send a "terima kasih" + onboarding note. The detection
      // counts non-refund PAID rows; this current payment is already in
      // the tx so count==1 means "this is the only one". Fires per booking
      // not per paket — a returning jemaah gets one thanks per trip.
      const priorPaidCount = await db.payment.count({
        where: {
          bookingId,
          status: 'PAID',
          // Exclude the row we just inserted
          id: { not: payment.id },
        },
      });
      if (priorPaidCount === 0) {
        await notifyFirstPaymentThanks({
          booking: bookingForNotif,
          payment,
        });
      }
    }
  } catch (err) {
    console.error('[payment] notif failed:', err.message);
  }

  // Stage 108 — outbound webhook fan-out (payment.received + optional
  // booking.lunas when this payment closed the booking).
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    const amt = Number(payment.amount?.toString?.() ?? payment.amount) || 0;
    await dispatchEvent('payment.received', {
      bookingId,
      bookingNo: updatedBooking.bookingNo,
      paymentId: payment.id,
      amount: amt,
      method: payment.method,
      currency: payment.currency,
      // S128 — paketId so per-paket subs can filter
      paketId: updatedBooking.paketId,
      bookingStatus: updatedBooking.status,
    });
    if (statusChanged && updatedBooking.status === 'LUNAS') {
      await dispatchEvent('booking.lunas', {
        bookingId,
        bookingNo: updatedBooking.bookingNo,
        // S128 — paketId so per-paket subs can filter
        paketId: updatedBooking.paketId,
        totalAmount: Number(updatedBooking.totalAmount?.toString?.() ?? updatedBooking.totalAmount) || 0,
        finalPaymentId: payment.id,
      });
    }
    // Stage 127 — generic state-change event for partners who track
    // lifecycle without subscribing to every specific transition. Fires
    // on every forward status change (BOOKED, DP_PAID, PARTIAL, LUNAS).
    if (statusChanged) {
      await dispatchEvent('booking.status_changed', {
        bookingId,
        bookingNo: updatedBooking.bookingNo,
        paketId: updatedBooking.paketId,
        previousStatus: booking.status,
        status: updatedBooking.status,
      });
    }
  } catch (err) {
    console.warn('[payment] webhook dispatch failed:', err?.message || err);
  }

  return { payment, booking: updatedBooking, statusChanged, komisi };
}
