// CLI: `node src/jobs/send-manifest-close.js`
// Stage 141 — daily nudge to jemaah whose manifest closes < 72h AND
// who still has missing required docs. Silent on healthy days
// (no candidates → no email).
import { db } from '../lib/db.js';
import { getManifestCloseNudgeCandidates } from '../services/manifestCloseNudge.js';
import { notifyManifestCloseNudge } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-manifest-close] start ${startedAt.toISOString()}`);

try {
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
  console.log(`[send-manifest-close] candidates=${result.candidateCount} overdue=${result.overdueCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-manifest-close] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-manifest-close] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
