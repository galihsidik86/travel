import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { assignBookingToRoom, unassignBooking, swapBookingRooms, bulkAssignRoomsByFloor } from '../services/bunking.js';

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

// Stage 200 — bulk assign unassigned bookings to rooms on a floor
const BulkAssignSchema = z.object({
  paketId: z.string().min(1),
  floor: z.preprocess((v) => Number(v), z.number().int()),
});
router.post(
  '/bulk-assign-floor',
  asyncHandler(async (req, res) => {
    const { paketId, floor } = BulkAssignSchema.parse(req.body);
    const result = await bulkAssignRoomsByFloor({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      paketId, floor,
    });
    res.json(result);
  }),
);

// Stage 178 — swap two bookings' room assignments in one transaction.
const SwapSchema = z.object({
  bookingIdA: z.string().min(1),
  bookingIdB: z.string().min(1),
});
router.post(
  '/swap',
  asyncHandler(async (req, res) => {
    const { bookingIdA, bookingIdB } = SwapSchema.parse(req.body);
    const result = await swapBookingRooms({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      bookingIdA, bookingIdB,
    });
    res.json(result);
  }),
);

export default router;
