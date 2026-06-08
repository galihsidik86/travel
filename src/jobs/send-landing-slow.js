// CLI: `node src/jobs/send-landing-slow.js`
// Daily 08:45 — reads getLandingSpeed snapshot, fans an alert when
// p95 latency > budget AND sample is sufficient (not lowSample).
// Silent otherwise.
import { db } from '../lib/db.js';
import { getLandingSpeed } from '../services/paketView.js';
import { notifyLandingSlow } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-landing-slow] start ${startedAt.toISOString()}`);

try {
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
  console.log(`[send-landing-slow] p95=${result.p95}ms sample=${result.sample} overBudget=${result.overBudget} enqueued=${result.enqueued}`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-landing-slow] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
