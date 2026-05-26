// 5tt: admin viewer for PaymentIntent (cross-booking ops investigation).
// Mounted at /admin/payment-intents.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listPaymentIntents, PAYMENT_INTENT_STATUSES,
} from '../services/paymentGateway.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = PAYMENT_INTENT_STATUSES.includes(req.query.status) ? req.query.status : 'ALL';
    const search = (req.query.q || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const data = await listPaymentIntents({
      status: status === 'ALL' ? undefined : status,
      search, from, to, page,
    });

    res.render('payment-intents-list', {
      user: req.user,
      ...data,
      filters: { status, search, from, to },
      META: { STATUSES: PAYMENT_INTENT_STATUSES },
    });
  }),
);

export default router;
