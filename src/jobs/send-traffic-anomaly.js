// CLI: `node src/jobs/send-traffic-anomaly.js`
// Daily 08:30 — after the digest sequence. Detects paket whose
// yesterday visit count dropped ≥50% vs trailing 7-day avg (baseline
// ≥5 visits/day required to avoid false alarms on sleepy paket).
// Silent when no anomalies.
import { db } from '../lib/db.js';
import { getTrafficAnomalies } from '../services/trafficAnomaly.js';
import { notifyTrafficAnomalies } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-traffic-anomaly] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-traffic-anomaly', async () => {
    const anomalies = await getTrafficAnomalies();
    const fan = await notifyTrafficAnomalies({ anomalies });
    return {
      paketCount: anomalies.rows.length,
      enqueued: fan.enqueued ?? 0,
      skipped: fan.skipped ?? false,
    };
  });
  console.log(`[send-traffic-anomaly] paketCount=${result.paketCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-traffic-anomaly] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
