// HTTP triggers for ops jobs. Mounted under /api/admin/jobs.
// OWNER only — these are admin maintenance actions.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { expireOverdueDocuments } from '../services/expireDocs.js';
import { processPendingNotifications, notifyDailyDigest, notifyWeeklyDigest, notifyAgentWeeklyDigest } from '../services/notifications.js';
import { expireStaleIntents } from '../services/expireIntents.js';
import { pruneRetentionWindows } from '../services/retention.js';
import { buildDigestWithAttention } from '../services/dailyDigest.js';
import { buildWeeklyDigest } from '../services/weeklyDigest.js';
import { buildAgentWeeklyDigest, listActiveAgentsForDigest } from '../services/agentWeeklyDigest.js';
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
  '/send-daily-digest',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-daily-digest', async () => {
      const digest = await buildDigestWithAttention();
      const fan = await notifyDailyDigest({ digest });
      return {
        date: digest.date,
        recipients: fan.recipients ?? 0,
        enqueued: fan.enqueued ?? 0,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-weekly-digest',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-weekly-digest', async () => {
      const digest = await buildWeeklyDigest();
      const fan = await notifyWeeklyDigest({ digest });
      return {
        weekStart: digest.weekStart,
        recipients: fan.recipients ?? 0,
        enqueued: fan.enqueued ?? 0,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-agent-weekly-digest',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-agent-weekly-digest', async () => {
      const agents = await listActiveAgentsForDigest();
      let enqueued = 0;
      let skipped = 0;
      let errors = 0;
      for (const a of agents) {
        try {
          const digest = await buildAgentWeeklyDigest({ agentId: a.id });
          if (!digest) { skipped += 1; continue; }
          const fan = await notifyAgentWeeklyDigest({ digest });
          enqueued += fan.enqueued ?? 0;
        } catch (err) {
          console.warn(`[agent-weekly-digest] agent ${a.slug} failed:`, err?.message || err);
          errors += 1;
        }
      }
      return { agents: agents.length, enqueued, skipped, errors };
    });
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
