// HTTP triggers for ops jobs. Mounted under /api/admin/jobs.
// OWNER only — these are admin maintenance actions.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { expireOverdueDocuments } from '../services/expireDocs.js';
import { processPendingNotifications } from '../services/notifications.js';
import { expireStaleIntents } from '../services/expireIntents.js';
import { pruneRetentionWindows } from '../services/retention.js';
import { runJob } from '../lib/jobRunner.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER'));

router.post(
  '/expire-docs',
  asyncHandler(async (req, res) => {
    const result = await runJob('expire-docs', () => expireOverdueDocuments({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
    }));
    res.json(result);
  }),
);

router.post(
  '/send-notifications',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-notifications', () => processPendingNotifications());
    res.json(result);
  }),
);

router.post(
  '/expire-intents',
  asyncHandler(async (req, res) => {
    const result = await runJob('expire-intents', () => expireStaleIntents({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
    }));
    res.json(result);
  }),
);

router.post(
  '/prune',
  asyncHandler(async (req, res) => {
    const result = await runJob('prune', () => pruneRetentionWindows({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
    }));
    res.json(result);
  }),
);

export default router;
