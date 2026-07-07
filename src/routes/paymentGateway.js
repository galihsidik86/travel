// 5pp: payment gateway routes — Midtrans Snap intent + webhook.
//
// /api/payments/intent           POST — jemaah creates an intent for their booking
// /api/payments/intent/:id       GET  — jemaah polls intent status
// /api/payments/midtrans/webhook POST — Midtrans posts here (signature-verified)
// /payments/midtrans/fake        GET  — local fake redirect (dev only; emulates jemaah completing the payment)
import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { env } from '../env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { verifyMidtransSignature, isMidtransFakeMode } from '../lib/midtrans.js';
import {
  createPaymentIntent, handleMidtransNotification, buildFakeWebhookPayload,
} from '../services/paymentGateway.js';

const router = Router();

// ── jemaah creates intent ────────────────────────────────────
const IntentCreateSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.coerce.number().positive(),
  replaceActive: z.coerce.boolean().optional(),
});

router.post(
  '/api/payments/intent',
  requireAuth, requireRole('JEMAAH'),
  asyncHandler(async (req, res) => {
    const data = IntentCreateSchema.parse(req.body);
    // Ownership check: booking must belong to this jemaah
    const booking = await db.booking.findFirst({
      where: { id: data.bookingId, jemaahUserId: req.user.id },
      select: { id: true },
    });
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');

    const intent = await createPaymentIntent({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      bookingId: data.bookingId,
      amount: data.amount,
      replaceActive: !!data.replaceActive,
    });
    res.status(201).json({
      intent: {
        id: intent.id, orderId: intent.orderId,
        snapToken: intent.snapToken, snapRedirectUrl: intent.snapRedirectUrl,
        amount: intent.amount, status: intent.status, expiresAt: intent.expiresAt,
      },
    });
  }),
);

// ── jemaah polls intent status ───────────────────────────────
router.get(
  '/api/payments/intent/:id',
  requireAuth, requireRole('JEMAAH'),
  asyncHandler(async (req, res) => {
    const intent = await db.paymentIntent.findFirst({
      where: { id: req.params.id, booking: { jemaahUserId: req.user.id } },
      select: {
        id: true, orderId: true, status: true, gatewayStatus: true,
        amount: true, paymentId: true, expiresAt: true, createdAt: true,
      },
    });
    if (!intent) throw new HttpError(404, 'Intent tidak ditemukan', 'INTENT_NOT_FOUND');
    res.json({ intent });
  }),
);

// ── Midtrans webhook (public, signature-gated) ───────────────
// Midtrans calls this without our auth; we verify the signature in the body.
router.post(
  '/api/payments/midtrans/webhook',
  asyncHandler(async (req, res) => {
    const payload = req.body;
    if (!verifyMidtransSignature(payload)) {
      // Don't reveal anything about the intent on bad signature
      throw new HttpError(401, 'Invalid signature', 'BAD_SIGNATURE');
    }
    const result = await handleMidtransNotification({ req, payload });
    // Midtrans expects a 200 with any JSON body to consider the notification ack'd
    res.json({ ok: true, action: result.action, status: result.intent.status });
  }),
);

// ── Fake redirect for dev/smoke (only when fake mode active) ──
// Simulates the jemaah completing payment by building a valid webhook payload
// and invoking the handler in-process, then redirecting back to the booking.
router.get(
  '/payments/midtrans/fake',
  asyncHandler(async (req, res) => {
    // Belt-and-suspenders: this endpoint settles bookings without auth, so it
    // must NEVER be reachable in production even if fake mode were somehow
    // active (env guard already blocks that path at boot).
    if (env.NODE_ENV === 'production') {
      throw new HttpError(403, 'Endpoint tidak tersedia di produksi', 'NOT_AVAILABLE');
    }
    if (!isMidtransFakeMode()) throw new HttpError(403, 'Fake redirect dimatikan (kredensial Midtrans ter-set)', 'NOT_FAKE_MODE');
    const orderId = String(req.query.order_id || '');
    if (!orderId) throw new HttpError(400, 'order_id wajib', 'ORDER_ID_REQUIRED');
    const result = String(req.query.result || 'settlement'); // 'settlement' | 'pending' | 'deny' | 'expire' | 'cancel'

    const intent = await db.paymentIntent.findUnique({
      where: { orderId },
      select: { id: true, bookingId: true, amount: true, booking: { select: { id: true } } },
    });
    if (!intent) throw new HttpError(404, 'Intent tidak ditemukan', 'INTENT_NOT_FOUND');

    const payload = buildFakeWebhookPayload({
      orderId,
      amount: intent.amount,
      transaction_status: result,
      payment_type: 'bank_transfer',
    });
    await handleMidtransNotification({ req, payload });
    // Redirect jemaah back to their booking detail
    res.redirect(`/saya/bookings/${intent.bookingId}?paid=${result === 'settlement' ? 'ok' : encodeURIComponent(result)}`);
  }),
);

export default router;
