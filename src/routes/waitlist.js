// Stage 26 — paket waitlist routes.
// Public:  POST /api/waitlist
// Admin:   under /admin/paket/:slug/waitlist (mounted via paketAdmin)
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { joinWaitlist } from '../services/waitlist.js';

const router = Router();

const limiter = rateLimit({ windowMs: 60_000, max: 8, code: 'WAITLIST_RATE_LIMITED' });

router.post(
  '/',
  limiter,
  asyncHandler(async (req, res) => {
    const result = await joinWaitlist({
      req,
      paketSlug: req.body?.paketSlug,
      input: {
        fullName: req.body?.fullName,
        phone: req.body?.phone,
        notes: req.body?.notes,
      },
    });
    res.status(201).json({
      waitlist: {
        id: result.waitlist.id,
        status: result.waitlist.status,
        createdAt: result.waitlist.createdAt,
      },
      paket: { slug: result.paket.slug, title: result.paket.title },
    });
  }),
);

export default router;
