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
import { getWebhookHealthDigest } from '../services/webhookHealthDigest.js';
import { notifyWebhookHealth } from '../services/notifications.js';
import { getManifestCloseNudgeCandidates } from '../services/manifestCloseNudge.js';
import { notifyManifestCloseNudge } from '../services/notifications.js';
import { detectNoShows } from '../services/noShow.js';
import { generateAllAgentStatements, previousMonthYM } from '../services/komisiStatement.js';
import { sendAgentAnnualRecaps, previousYear } from '../services/agentAnnualRecap.js';
import { sendStatementUnreadNudges } from '../services/statementUnreadNudge.js';
import { sendPaymentReminders } from '../services/paymentReminder.js';
import { sendDocExpiringNudges } from '../services/docExpiringNudge.js';
import { scanAgentDormancy } from '../services/agentDormancy.js';
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
  '/send-webhook-health',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-webhook-health', async () => {
      const digest = await getWebhookHealthDigest({ days: 7 });
      const fan = await notifyWebhookHealth({ digest });
      return {
        totalWebhooks: digest.rows.length,
        unhealthyCount: digest.unhealthyCount,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/send-manifest-close',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-manifest-close', async () => {
      const candidates = await getManifestCloseNudgeCandidates({ windowHours: 72 });
      const fan = await notifyManifestCloseNudge({ candidates });
      return {
        candidateCount: candidates.rows.length,
        overdueCount: candidates.counts.overdue,
        enqueued: fan.enqueued ?? 0,
        skipped: fan.skipped ?? false,
      };
    });
    res.json(result);
  }),
);

router.post(
  '/generate-komisi-statements',
  asyncHandler(async (req, res) => {
    const period = req.body?.periodYM || previousMonthYM();
    const result = await runJob('generate-komisi-statements', () => generateAllAgentStatements({
      req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      periodYM: period,
    }));
    res.json(result);
  }),
);

router.post(
  '/send-agent-annual-recap',
  asyncHandler(async (req, res) => {
    const yearArg = parseInt(req.body?.year, 10);
    const year = Number.isFinite(yearArg) ? yearArg : previousYear();
    const result = await runJob('send-agent-annual-recap', () => sendAgentAnnualRecaps({ year }));
    res.json(result);
  }),
);

router.post(
  '/send-statement-unread-nudge',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-statement-unread-nudge', () => sendStatementUnreadNudges({}));
    res.json(result);
  }),
);

router.post(
  '/send-payment-reminder',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-payment-reminder', () => sendPaymentReminders({}));
    res.json(result);
  }),
);

router.post(
  '/send-doc-expiring',
  asyncHandler(async (_req, res) => {
    const result = await runJob('send-doc-expiring', () => sendDocExpiringNudges({}));
    res.json(result);
  }),
);

router.post(
  '/send-passport-renewal',
  asyncHandler(async (_req, res) => {
    const { sendPassportRenewalReminders } = await import('../services/passportRenewalReminder.js');
    const result = await runJob('send-passport-renewal', () => sendPassportRenewalReminders({}));
    res.json(result);
  }),
);

// Stage 213 — Monday-morning crew dietary brief for near-departure paket
router.post(
  '/send-crew-dietary-brief',
  asyncHandler(async (_req, res) => {
    const { sendCrewDietaryBriefs } = await import('../services/crewDietaryBrief.js');
    const result = await runJob('send-crew-dietary-brief', () => sendCrewDietaryBriefs({}));
    res.json(result);
  }),
);

// Stage 219 — daily pickup choice reminder for near-departure paket
router.post(
  '/send-pickup-reminder',
  asyncHandler(async (_req, res) => {
    const { sendPickupReminders } = await import('../services/pickupReminder.js');
    const result = await runJob('send-pickup-reminder', () => sendPickupReminders({}));
    res.json(result);
  }),
);

// Stage 227 — auto-publish DRAFT paket whose publishedAt has elapsed
router.post(
  '/auto-publish-paket',
  asyncHandler(async (_req, res) => {
    const { runAutoPublishPaket } = await import('../services/autoPublishPaket.js');
    const result = await runJob('auto-publish-paket', () => runAutoPublishPaket({}));
    res.json(result);
  }),
);

// Stage 232-234 — auto-tag backfill (LANSIA/PERTAMA/KELUARGA)
router.post(
  '/backfill-auto-tags',
  asyncHandler(async (_req, res) => {
    const { runAutoTagBackfill } = await import('../services/bookingAutoTag.js');
    const result = await runJob('backfill-auto-tags', () => runAutoTagBackfill({}));
    res.json(result);
  }),
);

// Stage 237 — auto-cancel stale unpaid PENDING bookings
router.post(
  '/auto-cancel-stale-pending',
  asyncHandler(async (_req, res) => {
    const { runAutoCancelStalePending } = await import('../services/autoCancelStalePending.js');
    const result = await runJob('auto-cancel-stale-pending', () => runAutoCancelStalePending({}));
    res.json(result);
  }),
);

router.post(
  '/scan-agent-dormancy',
  asyncHandler(async (_req, res) => {
    const result = await runJob('scan-agent-dormancy', () => scanAgentDormancy({}));
    res.json(result);
  }),
);

router.post(
  '/detect-no-shows',
  asyncHandler(async (req, res) => {
    const result = await runJob('detect-no-shows', () => detectNoShows({
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
