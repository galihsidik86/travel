import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { assignBookingToRoom, unassignBooking } from '../services/bunking.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

const AssignSchema = z.object({
  bookingId: z.string().min(1),
  roomId: z.string().min(1),
});

const UnassignSchema = z.object({
  bookingId: z.string().min(1),
});

router.post(
  '/assign',
  asyncHandler(async (req, res) => {
    const { bookingId, roomId } = AssignSchema.parse(req.body);
    const booking = await assignBookingToRoom({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      bookingId, roomId,
    });
    res.status(201).json({ booking });
  }),
);

router.post(
  '/unassign',
  asyncHandler(async (req, res) => {
    const { bookingId } = UnassignSchema.parse(req.body);
    const booking = await unassignBooking({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      bookingId,
    });
    res.json({ booking });
  }),
);

export default router;
