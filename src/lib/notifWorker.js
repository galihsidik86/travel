// In-process notification worker (5cc).
//
// Wakes up every `intervalMs` and calls `processPendingNotifications`. Designed
// for dev convenience so notifs dispatch without a manual cron run. Production
// can keep this enabled or opt out via env (`NOTIF_WORKER_DISABLED=true`) and
// rely on system cron + the CLI script (`npm run job:send-notifications`).
//
// Idempotent start/stop — calling start twice is a no-op; stop is safe to call
// even if not running.
import { processPendingNotifications } from '../services/notifications.js';

let timer = null;
let running = false;

export function startNotifWorker({ intervalMs = 30_000, log = console.log } = {}) {
  if (timer) return; // already started
  log(`[notif-worker] starting · interval=${intervalMs}ms`);

  const tick = async () => {
    if (running) return;     // prevent overlap on slow runs
    running = true;
    try {
      const result = await processPendingNotifications();
      if (result.processed > 0) {
        log(`[notif-worker] tick · processed=${result.processed} sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
      }
    } catch (err) {
      console.error('[notif-worker] tick failed:', err.message);
    } finally {
      running = false;
    }
  };

  // First tick after a short delay so server boot logs land first
  timer = setTimeout(async () => {
    await tick();
    timer = setInterval(tick, intervalMs);
  }, 2000);
}

export function stopNotifWorker() {
  if (!timer) return;
  clearInterval(timer);
  clearTimeout(timer); // works for both setTimeout/setInterval handles
  timer = null;
}
