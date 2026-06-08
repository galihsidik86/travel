// CLI: `node src/jobs/send-incident-escalate.js`
// Stage 80 — promote stale OPEN incidents to OWNER tier when the admin desk
// hasn't acked within the threshold. Cron at 10–15 min intervals; idempotent
// via `Incident.escalatedAt` so duplicate runs are no-ops.
import { db } from '../lib/db.js';
import { escalateStaleIncidents } from '../services/incidentEscalate.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-incident-escalate] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-incident-escalate', () => escalateStaleIncidents());
  console.log(`[send-incident-escalate] scanned=${result.scanned} escalated=${result.escalated}`);
  if (result.escalated > 0) {
    console.log(`[send-incident-escalate] candidates=${result.candidates.join(',')}`);
  }
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-incident-escalate] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-incident-escalate] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
