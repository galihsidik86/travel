import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { issueRefund } from '../services/refund.js';

const router = Router();

// More restrictive than payments — KASIR cannot issue refunds.
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

const RefundSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.preprocess((v) => Number(v), z.number().positive().max(50_000_000_000)),
  method: z.enum(['VA', 'QRIS', 'EWALLET', 'CARD', 'TRANSFER', 'CASH']),
  reason: z.string().min(3, 'Alasan refund min. 3 karakter').max(2000),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = RefundSchema.parse(req.body);
    const result = await issueRefund({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      ...data,
    });
    res.status(201).json(result);
  }),
);

export default router;
