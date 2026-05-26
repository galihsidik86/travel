// HTTP triggers for ops jobs. Mounted under /api/admin/jobs.
// OWNER only — these are admin maintenance actions.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { expireOverdueDocuments } from '../services/expireDocs.js';
import { processPendingNotifications } from '../services/notifications.js';
import { expireStaleIntents } from '../services/expireIntents.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER'));

router.post(
  '/expire-docs',
  asyncHandler(async (req, res) => {
    const result = await expireOverdueDocuments({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
    });
    res.json(result);
  }),
);

router.post(
  '/send-notifications',
  asyncHandler(async (req, res) => {
    const result = await processPendingNotifications();
    res.json(result);
  }),
);

router.post(
  '/expire-intents',
  asyncHandler(async (req, res) => {
    const result = await expireStaleIntents({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
    });
    res.json(result);
  }),
);

export default router;
