// Stage 129 — weekly per-webhook delivery health rollup.
//
// "Where is partner-side delivery hurting?" — surfaces failure rate +
// retry burden + dominant error message per webhook over the last 7
// days. Fan-out is silent on all-healthy weeks; OWNER inbox only lights
// up when there's something to fix.
//
// Latency tracking deferred — WebhookDelivery doesn't carry durationMs
// today (the diagnostic columns are status + error). Adding p95 here
// would mean a migration + dispatcher rewrite without a clear payoff
// over the simpler "X% delivered successfully" signal. If a partner
// reports timeout regressions later, that's the right time to add it.
import { db } from '../lib/db.js';

const DEFAULT_DAYS = 7;
// Only flag a webhook in the digest when there's actually a problem —
// 100% successful weeks don't need an email. Threshold = "any failed
// row in the window OR any pending row stuck > 1h".
const STUCK_PENDING_MS = 60 * 60 * 1000;

/**
 * Build a per-webhook health snapshot over the last `days`. Returns
 * `{windowStart, windowEnd, rows[], unhealthyCount, hasIssues}`.
 *
 * Each row carries `{webhook, totals: {total, succeeded, failed, pending,
 * stuckPending, successRatePct}, topError, attemptInflation}`.
 *
 *   attemptInflation = sum(attemptCount) / total — a value > 1 means
 *   partner endpoint required retries to succeed (or is still failing).
 *
 * Rows are sorted "worst first" — sticks the actionable items at the
 * top of the email.
 */
export async function getWebhookHealthDigest({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);

  const webhooks = await db.webhook.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, url: true, description: true, paket: { select: { slug: true, title: true } } },
  });
  if (webhooks.length === 0) {
    return { windowStart, windowEnd, rows: [], unhealthyCount: 0, hasIssues: false };
  }

  const stuckCutoff = new Date(windowEnd.getTime() - STUCK_PENDING_MS);

  const rows = [];
  for (const wh of webhooks) {
    const deliveries = await db.webhookDelivery.findMany({
      where: { webhookId: wh.id, createdAt: { gte: windowStart } },
      select: { status: true, attemptCount: true, lastError: true, createdAt: true },
    });
    const total = deliveries.length;
    if (total === 0) {
      rows.push({
        webhook: wh,
        totals: { total: 0, succeeded: 0, failed: 0, pending: 0, stuckPending: 0, successRatePct: null },
        topError: null,
        attemptInflation: null,
        healthy: true, // No traffic = no problem (silently dropped from email)
      });
      continue;
    }
    let succeeded = 0, failed = 0, pending = 0, stuckPending = 0, totalAttempts = 0;
    const errorTally = new Map();
    for (const d of deliveries) {
      totalAttempts += d.attemptCount || 0;
      if (d.status === 'SUCCEEDED') succeeded += 1;
      else if (d.status === 'FAILED') failed += 1;
      else if (d.status === 'PENDING') {
        pending += 1;
        if (d.createdAt < stuckCutoff) stuckPending += 1;
      }
      if (d.lastError) {
        const key = String(d.lastError).slice(0, 200);
        errorTally.set(key, (errorTally.get(key) || 0) + 1);
      }
    }
    // successRatePct includes only TERMINAL rows — pending is "we don't
    // know yet"; counting it as either would skew the read.
    const terminal = succeeded + failed;
    const successRatePct = terminal === 0 ? null : Math.round((succeeded / terminal) * 1000) / 10;
    const attemptInflation = total === 0 ? null : Math.round((totalAttempts / total) * 100) / 100;
    let topError = null;
    for (const [msg, count] of errorTally.entries()) {
      if (!topError || count > topError.count) topError = { message: msg, count };
    }
    const healthy = failed === 0 && stuckPending === 0;
    rows.push({
      webhook: wh,
      totals: { total, succeeded, failed, pending, stuckPending, successRatePct },
      topError,
      attemptInflation,
      healthy,
    });
  }

  // Sort worst-first: unhealthy with most failures + stuck rows at the
  // top, then healthy rows (which the email skips anyway). Within
  // unhealthy: more failed first, then more stuck.
  rows.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    if (b.totals.failed !== a.totals.failed) return b.totals.failed - a.totals.failed;
    return b.totals.stuckPending - a.totals.stuckPending;
  });

  const unhealthyCount = rows.filter((r) => !r.healthy).length;
  return {
    windowStart, windowEnd,
    rows, unhealthyCount,
    hasIssues: unhealthyCount > 0,
  };
}
