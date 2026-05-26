// 5pp: PaymentIntent lifecycle — create → settle → materialize Payment row.
//
// Important invariants:
//   • `recordPayment` (in src/services/payment.js) is the SINGLE place that
//     creates Payment rows + transitions Booking.status + issues Komisi.
//     Webhook handling DEFERS to it instead of re-implementing the money math.
//   • Webhook is IDEMPOTENT — Midtrans retries notifications on failure, and
//     the same `order_id` may arrive multiple times. We guard on
//     `intent.paymentId != null` before calling `recordPayment` so duplicate
//     SETTLED webhooks don't double-credit the booking.
//   • Signature verification happens at the route layer (verifyMidtransSignature)
//     BEFORE calling `handleMidtransNotification` — this service trusts that
//     the payload is authentic.
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { toNumber } from './../lib/format.js';
import {
  createSnapTransaction, mapMidtransStatus, mapMidtransMethod, isMidtransFakeMode,
} from '../lib/midtrans.js';
import { recordPayment } from './payment.js';

const SNAP_EXPIRE_MIN = 60; // intents expire 1h after creation by default

/**
 * Create a PaymentIntent for a booking + ask Midtrans Snap for a token.
 * Returns the created intent row with snap token + redirect URL filled in.
 *
 * Validation:
 *   - Booking must exist, not CANCELLED/REFUNDED.
 *   - amount must be ≤ remaining (totalAmount - paidAmount) and > 0.
 *   - Refuses if there's already a CREATED/PENDING intent on this booking
 *     (prevents accidental double-charging UI). Caller can pass
 *     `replaceActive=true` to cancel any active intent first.
 */
export async function createPaymentIntent({ req, actor, bookingId, amount, replaceActive = false }) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true,
      totalAmount: true, paidAmount: true,
      paket: { select: { title: true } },
      jemaah: { select: { fullName: true, email: true, phone: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa terima pembayaran baru', 'BOOKING_CLOSED');
  }
  const total = toNumber(booking.totalAmount) ?? 0;
  const paid = toNumber(booking.paidAmount) ?? 0;
  const remaining = total - paid;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new HttpError(400, 'Jumlah harus > 0', 'INVALID_AMOUNT');
  }
  if (amt > remaining) {
    throw new HttpError(409,
      `Jumlah ${amt.toLocaleString('id-ID')} melebihi sisa ${remaining.toLocaleString('id-ID')}`,
      'AMOUNT_EXCEEDS_REMAINING');
  }

  // Check for active intent
  const active = await db.paymentIntent.findFirst({
    where: { bookingId, status: { in: ['CREATED', 'PENDING'] } },
  });
  if (active) {
    if (!replaceActive) {
      throw new HttpError(409, 'Sudah ada intent pembayaran aktif untuk booking ini', 'INTENT_ALREADY_ACTIVE');
    }
    await db.paymentIntent.update({
      where: { id: active.id },
      data: { status: 'CANCELLED' },
    });
  }

  // Create row first (so we have intent.id → orderId mapping), then call Midtrans
  const expiresAt = new Date(Date.now() + SNAP_EXPIRE_MIN * 60_000);
  const intent = await db.paymentIntent.create({
    data: {
      bookingId, amount: amt.toFixed(2), currency: 'IDR',
      orderId: '', // placeholder, patched below
      status: 'CREATED',
      expiresAt,
    },
  });
  const orderId = `PI-${intent.id}`;
  const snap = await createSnapTransaction({
    orderId, amount: amt,
    customer: booking.jemaah,
    itemName: `${booking.bookingNo} · ${booking.paket?.title || 'Booking'}`,
  });

  const updated = await db.paymentIntent.update({
    where: { id: intent.id },
    data: {
      orderId,
      snapToken: snap.token,
      snapRedirectUrl: snap.redirect_url,
    },
  });

  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaymentIntent', entityId: updated.id,
    after: {
      bookingId, bookingNo: booking.bookingNo, orderId,
      amount: amt, provider: 'MIDTRANS', fakeMode: !!snap.fake,
    },
  });
  return updated;
}

/**
 * Process an authenticated Midtrans webhook payload. Idempotent.
 *
 * Returns { intent, payment, action: 'SETTLED' | 'STATUS_UPDATED' | 'NOOP' }.
 *   - SETTLED:        intent transitioned to SETTLED; a new Payment row was created.
 *   - STATUS_UPDATED: status changed but not yet terminal-happy (e.g. PENDING → PENDING again, or → FAILED/CANCELLED).
 *   - NOOP:           already terminal or no-op (e.g. duplicate SETTLED).
 */
export async function handleMidtransNotification({ req, payload }) {
  const orderId = payload.order_id;
  if (!orderId) throw new HttpError(400, 'order_id missing', 'INVALID_PAYLOAD');

  const intent = await db.paymentIntent.findUnique({
    where: { orderId },
    include: {
      booking: { select: { id: true, bookingNo: true } },
    },
  });
  if (!intent) throw new HttpError(404, 'Intent tidak ditemukan', 'INTENT_NOT_FOUND');

  const newStatus = mapMidtransStatus(payload);
  const wasTerminal = ['SETTLED', 'EXPIRED', 'CANCELLED', 'FAILED'].includes(intent.status);

  // Duplicate SETTLED (Midtrans retries) — already linked to a Payment, no-op.
  if (intent.status === 'SETTLED' && intent.paymentId) {
    return { intent, payment: null, action: 'NOOP' };
  }

  // Only materialize a Payment on the FIRST SETTLED transition.
  if (newStatus === 'SETTLED' && intent.status !== 'SETTLED') {
    const method = mapMidtransMethod(payload.payment_type);
    const gatewayRef = payload.transaction_id || `MT-${orderId}`;
    const amt = Number(payload.gross_amount) || toNumber(intent.amount) || 0;

    const { payment } = await recordPayment({
      req,
      actor: { email: 'midtrans-webhook', role: null }, // system actor (audit lib accepts null role)
      bookingId: intent.bookingId,
      amount: amt,
      method,
      currency: payload.currency || 'IDR',
      gatewayRef,
      vaNumber: payload.va_numbers?.[0]?.va_number || null,
      notes: `Midtrans ${payload.payment_type || ''} · ${payload.transaction_status}`.trim(),
    });

    const updated = await db.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'SETTLED',
        gatewayStatus: payload.transaction_status,
        gatewayPayload: payload,
        paymentId: payment.id,
      },
    });

    await audit({
      req, actor: { email: 'midtrans-webhook', role: null },
      action: 'STATUS_CHANGE', entity: 'PaymentIntent', entityId: intent.id,
      before: { status: intent.status },
      after: {
        status: 'SETTLED', orderId, paymentId: payment.id,
        gatewayStatus: payload.transaction_status, amount: amt,
      },
    });

    // 5yy: admin fan-out — non-blocking so webhook ack to Midtrans never
    // depends on notif success. recordPayment already updated the booking
    // (status + paidAmount), so we re-fetch the canonical post-state for
    // accurate email content.
    try {
      const { notifyPaymentSettledAdmin } = await import('./notifications.js');
      const freshBooking = await db.booking.findUnique({
        where: { id: intent.bookingId },
        select: {
          id: true, bookingNo: true, kelas: true, paxCount: true, status: true,
          jemaah: { select: { fullName: true, phone: true } },
          paket: { select: { title: true } },
        },
      });
      if (freshBooking) {
        await notifyPaymentSettledAdmin({
          booking: freshBooking,
          payment,
          intent: updated,
          paymentTypeRaw: payload.payment_type || null,
        });
      }
    } catch (err) {
      console.error('[paymentGateway] admin notif failed:', err.message);
    }

    return { intent: updated, payment, action: 'SETTLED' };
  }

  // Non-settle transition (PENDING/FAILED/EXPIRED/CANCELLED).
  // If we're already terminal, just snapshot the latest gateway payload but
  // don't change status — terminal is terminal.
  const dataPatch = {
    gatewayStatus: payload.transaction_status,
    gatewayPayload: payload,
    ...(wasTerminal ? {} : { status: newStatus }),
  };
  const updated = await db.paymentIntent.update({
    where: { id: intent.id },
    data: dataPatch,
  });

  await audit({
    req, actor: { email: 'midtrans-webhook', role: null },
    action: 'STATUS_CHANGE', entity: 'PaymentIntent', entityId: intent.id,
    before: { status: intent.status },
    after: { status: updated.status, orderId, gatewayStatus: payload.transaction_status },
  });
  return { intent: updated, payment: null, action: wasTerminal ? 'NOOP' : 'STATUS_UPDATED' };
}

// 5tt: status filter options for the admin viewer (matches PaymentIntentStatus enum)
export const PAYMENT_INTENT_STATUSES = ['CREATED', 'PENDING', 'SETTLED', 'EXPIRED', 'CANCELLED', 'FAILED'];

/**
 * Global paginated list of payment intents for the admin viewer (5tt).
 *
 * Filters:
 *   - status: one of PAYMENT_INTENT_STATUSES, or undefined for all
 *   - search: matches orderId OR booking.bookingNo (case-insensitive contains)
 *   - from/to: createdAt range (Date or YYYY-MM-DD string); inclusive
 *   - page: 1-indexed; pageSize default 50
 *
 * Returns { rows, total, page, pageSize, totalPages, countsByStatus }.
 * `countsByStatus` is computed WITHOUT the status filter so the KPI strip can
 * always show all-status totals for the current search+date scope.
 */
const PAGE_SIZE = 50;

export async function listPaymentIntents({ status, search, from, to, page = 1 } = {}) {
  const pageSize = PAGE_SIZE;
  const p = Math.max(1, Number(page) || 1);

  const dateFilter = {};
  if (from) {
    const d = from instanceof Date ? from : new Date(`${from}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) dateFilter.gte = d;
  }
  if (to) {
    const d = to instanceof Date ? to : new Date(`${to}T23:59:59Z`);
    if (!Number.isNaN(d.getTime())) dateFilter.lte = d;
  }

  // Search applies to orderId OR the booking's bookingNo (substring contains)
  const searchTerm = (search || '').trim();
  const searchFilter = searchTerm
    ? { OR: [
        { orderId: { contains: searchTerm } },
        { booking: { is: { bookingNo: { contains: searchTerm } } } },
      ] }
    : null;

  // Base WHERE (search + date), without status — used for both the row query
  // (intersected with status filter) and the per-status KPI counts.
  const baseWhere = {
    ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
    ...(searchFilter || {}),
  };

  const whereWithStatus = status && PAYMENT_INTENT_STATUSES.includes(status)
    ? { ...baseWhere, status }
    : baseWhere;

  const [total, rows, statusGroups] = await Promise.all([
    db.paymentIntent.count({ where: whereWithStatus }),
    db.paymentIntent.findMany({
      where: whereWithStatus,
      orderBy: { createdAt: 'desc' },
      skip: (p - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, orderId: true, provider: true,
        amount: true, currency: true,
        status: true, gatewayStatus: true,
        paymentId: true, expiresAt: true,
        createdAt: true,
        booking: { select: { id: true, bookingNo: true, status: true } },
      },
    }),
    db.paymentIntent.groupBy({
      by: ['status'], _count: { _all: true },
      where: baseWhere,
    }),
  ]);

  const countsByStatus = Object.fromEntries(PAYMENT_INTENT_STATUSES.map((s) => [s, 0]));
  for (const g of statusGroups) countsByStatus[g.status] = g._count._all;

  return {
    rows, total, page: p, pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    countsByStatus,
  };
}

/**
 * 5xx: find the latest non-terminal (CREATED/PENDING) intent for a booking
 * owned by this jemaah user. Returns null when there's no live intent.
 * Used by the booking detail view to render the polling card.
 *
 * Ownership scope: filter on `booking.jemaahUserId = userId` so a stranger
 * with a guessed bookingId gets null, not a peek at someone else's intent.
 */
export async function getActiveIntentForJemaahBooking({ userId, bookingId }) {
  return db.paymentIntent.findFirst({
    where: {
      bookingId,
      booking: { jemaahUserId: userId },
      status: { in: ['CREATED', 'PENDING'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, orderId: true, status: true,
      amount: true, snapRedirectUrl: true,
      gatewayStatus: true, expiresAt: true, createdAt: true,
    },
  });
}

/**
 * Per-booking list of all intents (latest first). Used by the admin booking
 * detail page (5qq). Lightweight projection — full `gatewayPayload` is
 * trimmed since it can be large; admin can drill into a single intent
 * separately if needed.
 */
export async function listIntentsForBooking(bookingId) {
  return db.paymentIntent.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, orderId: true, provider: true,
      amount: true, currency: true,
      status: true, gatewayStatus: true,
      paymentId: true, expiresAt: true,
      createdAt: true, updatedAt: true,
    },
  });
}

/**
 * Admin "cancel stuck intent" (5qq). Used when a Snap session is dead but
 * Midtrans never sent a webhook (e.g. user closed the browser tab). Marking
 * the intent CANCELLED frees the booking for a fresh intent on next attempt
 * without the active-intent guard tripping.
 *
 * Rules:
 *   - Only CREATED or PENDING intents can be cancelled this way.
 *   - SETTLED/EXPIRED/CANCELLED/FAILED → 409 (terminal is terminal — admin
 *     can't retroactively cancel a settled payment, that's a refund flow).
 *   - Does NOT touch any Payment row (settled intents already linked one).
 */
export async function cancelStuckIntent({ req, actor, intentId, reason }) {
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new HttpError(404, 'Intent tidak ditemukan', 'INTENT_NOT_FOUND');
  if (intent.status !== 'CREATED' && intent.status !== 'PENDING') {
    throw new HttpError(409,
      `Intent ${intent.status} tidak bisa di-cancel (hanya CREATED/PENDING). Untuk SETTLED gunakan refund.`,
      'INTENT_NOT_CANCELLABLE');
  }
  const updated = await db.paymentIntent.update({
    where: { id: intentId },
    data: { status: 'CANCELLED' },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'PaymentIntent', entityId: intent.id,
    before: { status: intent.status },
    after: {
      status: 'CANCELLED', orderId: intent.orderId,
      reason: reason?.trim() || null,
      adminCancel: true,
    },
  });
  return updated;
}

/**
 * Smoke / dev helper: build a webhook-shaped payload for a given intent
 * and the desired `transaction_status`, including a valid signature_key.
 * Used by the local /payments/midtrans/fake redirect to simulate a callback.
 * Only safe to expose in fake mode.
 */
export function buildFakeWebhookPayload({ orderId, amount, transaction_status = 'settlement', payment_type = 'bank_transfer' }) {
  if (!isMidtransFakeMode()) {
    throw new HttpError(403, 'Fake webhook helper hanya tersedia saat MIDTRANS_SERVER_KEY kosong', 'NOT_FAKE_MODE');
  }
  const status_code = transaction_status === 'settlement' || transaction_status === 'capture' ? '200' : '202';
  const gross_amount = `${Number(amount).toFixed(2)}`;
  // Mirror verifyMidtransSignature: SHA512(order_id + status_code + gross_amount + server_key)
  // In fake mode env.MIDTRANS_SERVER_KEY is '' → hash deterministic.
  const signature_key = crypto.createHash('sha512')
    .update(`${orderId}${status_code}${gross_amount}`)
    .digest('hex');
  return {
    order_id: orderId,
    status_code,
    gross_amount,
    transaction_status,
    payment_type,
    transaction_id: `FAKE-TX-${Date.now()}`,
    currency: 'IDR',
    signature_key,
  };
}
