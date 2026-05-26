import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordPayment } from '../services/payment.js';

const router = Router();

const METHODS = ['VA', 'QRIS', 'EWALLET', 'CARD', 'TRANSFER', 'CASH'];
const CURRENCIES = ['IDR', 'USD', 'SAR'];

const RecordSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.preprocess((v) => Number(v), z.number().positive().max(50_000_000_000)),
  method: z.enum(METHODS),
  currency: z.enum(CURRENCIES).default('IDR'),
  notes: z.string().max(500).optional().nullable(),
  gatewayRef: z.string().max(190).optional().nullable(),
  vaNumber: z.string().max(50).optional().nullable(),
});

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR'));

// POST /api/payments — kasir/admin records a payment against a booking
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = RecordSchema.parse(req.body);
    const result = await recordPayment({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      ...data,
    });
    res.status(201).json(result);
  }),
);

export default router;
