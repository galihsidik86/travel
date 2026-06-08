// HTTP triggers for ops jobs. Mounted under /api/admin/jobs.
// OWNER only — these are admin maintenance actions.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { expireOverdueDocuments } from '../services/expireDocs.js';
import { processPendingNotifications, notifyDailyDigest, notifyWeeklyDigest, notifyAgentWeeklyDigest, notifyPayoutReminder, notifyStalledLeads, notifyTrafficAnomalies, notifyLandingSlow, notifyCrewWeeklyDigest } from '../services/notifications.js';
import { expireStaleIntents } from '../services/expireIntents.js';
import { pruneRetentionWindows } from '../services/retention.js';
import { buildDigestWithAttention } from '../services/dailyDigest.js';
import { buildWeeklyDigest } from '../services/weeklyDigest.js';
import { buildAgentWeeklyDigest, listActiveAgentsForDigest } from '../services/agentWeeklyDigest.js';
import { getOverduePayoutCandidates } from '../services/payoutReminder.js';
import { getStalledLeadsForAgent, listActiveAgentsForLeadsDigest } from '../services/stalledLeadsDigest.js';
import { getTrafficAnomalies } from '../services/trafficAnomaly.js';
import { getLandingSpeed } from '../services/paketView.js';
import { buildCrewWeeklyDigest, listActiveCrewForDigest } from '../services/crewWeeklyDigest.js';
import { escalateStaleIncidents } from '../services/incidentEscalate.js';
import { getIncidentSlaBreaches } from '../services/incidentSlaAlert.js';
import { notifyIncidentSlaBreach, notifyTaskOverdueEscalation } from '../services/notifications.js';
import { getOverdueTasks } from '../services/tasks.js';
import { processPendingDeliveries } from '../services/webhooks.js';
import { getApiKeyScopeDownCandidates } from '../services/apiKeyScopeDown.js';
import { notifyApiKeyScopeDown } from '../services/notifications.js';
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
  '/send-payout-reminder',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-payout-reminder', async () => {
      const candidates = await getOverduePayoutCandidates();
      const fan = await notifyPayoutReminder({ candidates });
      return {
        candidateCount: candidates.counts.candidates,
        grandTotalIdr: candidates.counts.grandTotalIdr,
        recipients: fan.recipients ?? 0,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-stalled-leads',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-stalled-leads', async () => {
      const agents = await listActiveAgentsForLeadsDigest();
      let enqueued = 0;
      let skipped = 0;
      let errors = 0;
      for (const a of agents) {
        try {
          const digest = await getStalledLeadsForAgent({ agentId: a.id });
          if (!digest || digest.rows.length === 0) { skipped += 1; continue; }
          const r = await notifyStalledLeads({ agent: a, digest });
          enqueued += r.enqueued ?? 0;
        } catch (err) {
          console.warn(`[stalled-leads] agent ${a.slug} failed:`, err?.message || err);
          errors += 1;
        }
      }
      return { agents: agents.length, enqueued, skipped, errors };
    });
    res.json(result);
  }),
);

router.post(
  '/send-traffic-anomaly',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-traffic-anomaly', async () => {
      const anomalies = await getTrafficAnomalies();
      const fan = await notifyTrafficAnomalies({ anomalies });
      return {
        paketCount: anomalies.rows.length,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-landing-slow',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-landing-slow', async () => {
      const speed = await getLandingSpeed();
      const fan = await notifyLandingSlow({ speed });
      return {
        p95: speed?.p95 ?? null,
        sample: speed?.sample ?? 0,
        overBudget: speed?.overBudget ?? false,
        lowSample: speed?.lowSample ?? false,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-crew-weekly-digest',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-crew-weekly-digest', async () => {
      const crew = await listActiveCrewForDigest();
      let enqueued = 0, skipped = 0, errors = 0;
      for (const c of crew) {
        try {
          const digest = await buildCrewWeeklyDigest({ userId: c.id });
          if (!digest) { skipped += 1; continue; }
          const r = await notifyCrewWeeklyDigest({ digest });
          if (r.skipped) skipped += 1;
          enqueued += r.enqueued ?? 0;
        } catch (err) {
          console.warn(`[crew-weekly] user ${c.id} failed:`, err?.message || err);
          errors += 1;
        }
      }
      return { crew: crew.length, enqueued, skipped, errors };
    });
    res.json(result);
  }),
);

router.post(
  '/send-incident-escalate',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-incident-escalate', () => escalateStaleIncidents());
    res.json(result);
  }),
);

router.post(
  '/retry-webhooks',
  asyncHandler(async (_req, res) => {
    const result = await runJob('retry-webhooks', () => processPendingDeliveries({ limit: 100 }));
    res.json(result);
  }),
);

router.post(
  '/send-api-scope-down',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-api-scope-down', async () => {
      const candidates = await getApiKeyScopeDownCandidates({ days: 30 });
      const fan = await notifyApiKeyScopeDown({ candidates });
      return {
        candidateCount: candidates.rows.length,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-task-overdue',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-task-overdue', async () => {
      const overdueResult = await getOverdueTasks();
      const fan = await notifyTaskOverdueEscalation({ overdueResult });
      return {
        overdueCount: overdueResult.counts.overdue,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-incident-sla-alert',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-incident-sla-alert', async () => {
      const breaches = await getIncidentSlaBreaches();
      const fan = await notifyIncidentSlaBreach({ breaches });
      return {
        breachCount: breaches.counts.breaches,
        incidentsTotal: breaches.counts.incidentsTotal,
        recipients: fan.recipients ?? 0,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
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
