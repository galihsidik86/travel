// CLI: `node src/jobs/send-incident-sla-alert.js`
// Stage 87 — weekly summary of incident SLA budget breaches over the previous
// Mon-Sun window. Silent (no emails) when nothing breached. Cron monday-ish.
import { db } from '../lib/db.js';
import { getIncidentSlaBreaches } from '../services/incidentSlaAlert.js';
import { notifyIncidentSlaBreach } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-incident-sla-alert] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-incident-sla-alert', async () => {
    const breaches = await getIncidentSlaBreaches();
    const fan = await notifyIncidentSlaBreach({ breaches });
    return {
      breachCount: breaches.counts.breaches,
      incidentsTotal: breaches.counts.incidentsTotal,
      windowFrom: breaches.window.from,
      windowTo: breaches.window.to,
      recipients: fan.recipients ?? 0,
      enqueued: fan.enqueued ?? 0,
      skipped: fan.skipped ?? false,
    };
  });
  console.log(`[send-incident-sla-alert] breaches=${result.breachCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-incident-sla-alert] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-incident-sla-alert] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
