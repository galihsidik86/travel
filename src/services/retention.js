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
  // Stage 57 — Lead soft-archive: COLD/LOST untouched ≥180 days are
  // soft-deleted so the agent's pipeline view stays focused on workable
  // leads. CONVERTED leads stay forever (booking history).
  staleLeadDays:     Number(process.env.RETENTION_STALE_LEAD_DAYS)     || 180,
  // Stage 102 — JEMAAH user soft-delete: accounts that never made a
  // non-cancelled booking AND haven't logged in for ≥365 days. Bookings
  // FK is SetNull on User delete, so real-paid bookings keep their
  // jemaahProfile link intact even after the user row is gone.
  inactiveJemaahDays: Number(process.env.RETENTION_INACTIVE_JEMAAH_DAYS) || 365,
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
    // Stage 57 — soft-archive stale COLD/LOST leads (deletedAt set, row
    // kept for audit). Soft not hard, so a manager can still review what
    // was archived by querying with `deletedAt: { not: null }`.
    staleLeads:   await archiveStaleLeads(now, w.staleLeadDays),
    // Stage 102 — soft-delete inactive jemaah accounts (no bookings, no recent login)
    inactiveJemaah: await pruneInactiveJemaah(now, w.inactiveJemaahDays),
  };
  const affected = result.notifSent.deleted
    + result.notifFailed.deleted
    + result.jobRun.deleted
    + result.intentFailed.deleted
    + result.staleLeads.archived
    + result.inactiveJemaah.softDeleted;

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

/**
 * Stage 57 — soft-archive COLD/LOST leads with updatedAt > N days ago.
 * Sets `deletedAt = now` so the row drops out of agent's pipeline view
 * (which already filters `deletedAt: null`) but remains in DB so audit
 * + a future "review archived" view can still surface it.
 *
 * WARM + CONVERTED leads are NEVER archived — WARM is workable
 * (just needs a follow-up), CONVERTED is booking history. The cron
 * runs weekly inside the prune job; admin can also tune the window via
 * `RETENTION_STALE_LEAD_DAYS` env var.
 */
async function archiveStaleLeads(now, days) {
  const cutoff = cutoffDate(now, days);
  const { count } = await db.lead.updateMany({
    where: {
      deletedAt: null,
      status: { in: ['COLD', 'LOST'] },
      updatedAt: { lt: cutoff },
    },
    data: { deletedAt: now },
  });
  return { archived: count, cutoff: cutoff.toISOString(), windowDays: days };
}

/**
 * Stage 102 — soft-delete JEMAAH users who never made a real booking and
 * haven't logged in for ≥N days. Bounded growth on the User table without
 * losing real customers.
 *
 * Eligibility (ALL of):
 *   - role = JEMAAH
 *   - deletedAt = null (not already soft-deleted)
 *   - createdAt < cutoff (account itself has aged ≥N days)
 *   - lastLoginAt < cutoff OR lastLoginAt = null (no recent login at all)
 *   - NO non-CANCELLED, non-REFUNDED bookings (`bookings: { none: {...} }`)
 *
 * The booking FK from User uses SetNull on delete, so any historical
 * paid bookings keep their `jemaahProfile` link via the profile FK; only
 * the `jemaahUserId` column drops to NULL. The JemaahProfile itself is
 * never touched — that's the customer record, the User row is just the
 * login credential.
 *
 * Soft-deletes (sets `User.deletedAt`) rather than hard-deleting so the
 * audit trail can still resolve the email if needed. Per-row audits are
 * deliberately skipped (same bounded-growth purpose as other prunes);
 * the count lands in the wrapper's single audit row.
 */
async function pruneInactiveJemaah(now, days) {
  const cutoff = cutoffDate(now, days);
  const result = await db.user.updateMany({
    where: {
      role: 'JEMAAH',
      deletedAt: null,
      createdAt: { lt: cutoff },
      OR: [
        { lastLoginAt: null },
        { lastLoginAt: { lt: cutoff } },
      ],
      bookings: {
        none: {
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
      },
    },
    data: { deletedAt: now },
  });
  return { softDeleted: result.count, cutoff: cutoff.toISOString(), windowDays: days };
}
