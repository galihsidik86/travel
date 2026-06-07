// CLI: `node src/jobs/send-payout-reminder.js`
// Monday ~07:15 — closes the digest sequence. Aggregates EARNED komisi
// per agent, filters by threshold (default Rp 1M), and emails admins
// the list of overdue payout candidates. Skipped silently when the list
// is empty so quiet weeks don't generate noise.
import { db } from '../lib/db.js';
import { getOverduePayoutCandidates } from '../services/payoutReminder.js';
import { notifyPayoutReminder } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-payout-reminder] start ${startedAt.toISOString()}`);

try {
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
  console.log(`[send-payout-reminder] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-payout-reminder] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-payout-reminder] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
