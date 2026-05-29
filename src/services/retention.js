// Data retention — bounded growth for operational tables.
//
// What's pruned and what isn't:
//
//   PRUNED (retention has a finite ceiling)
//     - Notification rows in terminal status (SENT, SKIPPED, or FAILED
//       past max retries) older than the cutoff. They're delivery
//       receipts — needed for short-term troubleshooting, not history.
//     - JobRun rows older than the cutoff. /api/health only needs the
//       latest successful run per job; everything older is observability
//       noise.
//     - PaymentIntent rows that ended in failure (EXPIRED / CANCELLED /
//       FAILED) past the cutoff. SETTLED intents are NEVER pruned —
//       they tie 1:1 to a Payment row (financial record).
//
//   KEPT FOREVER (compliance / financial / append-only)
//     - AuditLog. If volume eventually becomes a problem, archive to
//       cold storage (S3 etc.) — never delete in place.
//     - Payment. Append-only by invariant.
//     - Booking, Komisi, KomisiPayout, Lead, Incident, AttendanceMark.
//       Trip + financial history.
//
// Defaults are conservative (90–365 days). Tune via env vars or pass
// explicit windows when calling from a HTTP trigger.
//
// All counters are returned for the job runner to record in JobRun.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

export const DEFAULTS = Object.freeze({
  // Notification: 90 days (SENT/SKIPPED), 180 days (terminal FAILED).
  notifSentDays:     Number(process.env.RETENTION_NOTIF_SENT_DAYS)     || 90,
  notifFailedDays:   Number(process.env.RETENTION_NOTIF_FAILED_DAYS)   || 180,
  // JobRun: 90 days
  jobRunDays:        Number(process.env.RETENTION_JOB_RUN_DAYS)        || 90,
  // PaymentIntent terminal-failure: 365 days
  intentFailedDays:  Number(process.env.RETENTION_INTENT_FAILED_DAYS)  || 365,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function cutoffDate(now, days) {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Run all retention buckets at once. Returns aggregate counts + per-bucket
 * detail so callers (CLI / HTTP trigger / runJob) can log.
 *
 * `req` is forwarded to audit() so the retention sweep itself shows up in
 * AuditLog with an actor of `system` — the prune itself is auditable.
 */
export async function pruneRetentionWindows({ req, actor, now = new Date(), windows = {} } = {}) {
  const w = { ...DEFAULTS, ...windows };
  const result = {
    notifSent:    await pruneTerminalNotifications(now, w.notifSentDays, ['SENT', 'SKIPPED']),
    notifFailed:  await pruneTerminalFailedNotifications(now, w.notifFailedDays),
    jobRun:       await pruneJobRuns(now, w.jobRunDays),
    intentFailed: await pruneFailedIntents(now, w.intentFailedDays),
  };
  const affected = result.notifSent.deleted
    + result.notifFailed.deleted
    + result.jobRun.deleted
    + result.intentFailed.deleted;

  // Audit the sweep itself so the prune is visible in the timeline. Single
  // row; per-row deletes are intentionally NOT audited (would defeat the
  // bounded-growth purpose).
  if (affected > 0) {
    await audit({
      req: req ?? null,
      actor: actor ?? { email: 'system' },
      action: 'DELETE',
      entity: 'Retention',
      entityId: now.toISOString().slice(0, 10),
      after: { windows: w, result },
    }).catch((err) => console.warn('[retention] audit write failed:', err?.message || err));
  }

  return { scanned: affected, affected, ...result };
}

async function pruneTerminalNotifications(now, days, statuses) {
  const cutoff = cutoffDate(now, days);
  const { count } = await db.notification.deleteMany({
    where: {
      status: { in: statuses },
      createdAt: { lt: cutoff },
    },
  });
  return { deleted: count, cutoff: cutoff.toISOString(), windowDays: days };
}

async function pruneTerminalFailedNotifications(now, days) {
  const cutoff = cutoffDate(now, days);
  // Terminal-failed = status FAILED AND (nextRetryAt is null OR attemptCount
  // has hit MAX). The retry scheduler stops touching these — safe to drop.
  // Prisma can't OR with a NULL check easily inside a single deleteMany
  // alongside attemptCount, so we split into two deletes — both bounded by
  // the same cutoff, so totals add up cleanly for the counter.
  const a = await db.notification.deleteMany({
    where: {
      status: 'FAILED',
      nextRetryAt: null,
      createdAt: { lt: cutoff },
    },
  });
  const b = await db.notification.deleteMany({
    where: {
      status: 'FAILED',
      attemptCount: { gte: 5 },
      createdAt: { lt: cutoff },
    },
  });
  return { deleted: a.count + b.count, cutoff: cutoff.toISOString(), windowDays: days };
}

async function pruneJobRuns(now, days) {
  const cutoff = cutoffDate(now, days);
  const { count } = await db.jobRun.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  return { deleted: count, cutoff: cutoff.toISOString(), windowDays: days };
}

async function pruneFailedIntents(now, days) {
  const cutoff = cutoffDate(now, days);
  const { count } = await db.paymentIntent.deleteMany({
    where: {
      status: { in: ['EXPIRED', 'CANCELLED', 'FAILED'] },
      createdAt: { lt: cutoff },
    },
  });
  return { deleted: count, cutoff: cutoff.toISOString(), windowDays: days };
}
