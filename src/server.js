import { createApp } from './app.js';
import { env } from './env.js';
import { disconnectDb } from './lib/db.js';
import { startNotifWorker, stopNotifWorker } from './lib/notifWorker.js';
import { bootstrapNotifSenders } from './lib/notifBootstrap.js';
import { bootstrapWebPush } from './services/webPush.js';
import { stopRateLimit } from './middleware/rateLimit.js';

const app = createApp();
bootstrapNotifSenders();
await bootstrapWebPush();

const server = app.listen(env.PORT, () => {
  const banner = `
  ┌────────────────────────────────────────────────────┐
  │  RELIGIO PRO · ${env.NODE_ENV.padEnd(11)}                       │
  │  http://${env.HOST}:${env.PORT}${' '.repeat(Math.max(0, 33 - env.HOST.length - String(env.PORT).length))}│
  │  Health: http://${env.HOST}:${env.PORT}/api/health${' '.repeat(Math.max(0, 16 - env.HOST.length - String(env.PORT).length))}│
  └────────────────────────────────────────────────────┘`;
  console.log(banner);

  // In-process notif worker (5cc). Opt-out via env when relying on system cron.
  if (process.env.NOTIF_WORKER_DISABLED !== 'true') {
    const intervalMs = Number(process.env.NOTIF_WORKER_INTERVAL_MS) || 30_000;
    startNotifWorker({ intervalMs });
  }
});

const shutdown = (signal) => {
  console.log(`\n${signal} received — closing server…`);
  stopNotifWorker();
  server.close(async () => {
    await stopRateLimit();   // close Redis client / clear GC interval
    await disconnectDb();
    console.log('Closed cleanly.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
