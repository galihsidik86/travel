// Stage 129 — weekly per-webhook delivery health rollup.
//
// "Where is partner-side delivery hurting?" — surfaces failure rate +
// retry burden + dominant error message per webhook over the last 7
// days. Fan-out is silent on all-healthy weeks; OWNER inbox only lights
// up when there's something to fix.
//
// Stage 134 — latency tracking now live. WebhookDelivery.durationMs is
// captured by attemptDelivery on every fire (incl. timeouts), so the
// digest reports per-sub p95 + flags rows whose p95 crosses LATENCY_BUDGET_MS.
// A partner endpoint clocking 4-second responses on a 30/min budget is a
// signal the admin needs to see, even when success rate is still 100%.
import { db } from '../lib/db.js';

const DEFAULT_DAYS = 7;
// Only flag a webhook in the digest when there's actually a problem —
// 100% successful weeks don't need an email. Threshold = "any failed
// row in the window OR any pending row stuck > 1h OR p95 > budget".
const STUCK_PENDING_MS = 60 * 60 * 1000;
// Stage 134 — slow-but-working flag threshold. 2s is generous for a
// webhook receiver (most partner endpoints respond in <500ms); >2s
// usually means the partner is doing too much synchronous work in the
// handler. Tune if real production data shows the signal is noisy.
const LATENCY_BUDGET_MS = 2_000;
// Need ≥3 deliveries with durationMs in window before reporting a p95.
// Below that the percentile is noise (1-2 outliers swing it wildly).
const LATENCY_MIN_SAMPLE = 3;

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
      select: { status: true, attemptCount: true, lastError: true, createdAt: true, durationMs: true },
    });
    const total = deliveries.length;
    if (total === 0) {
      rows.push({
        webhook: wh,
        totals: { total: 0, succeeded: 0, failed: 0, pending: 0, stuckPending: 0, successRatePct: null },
        topError: null,
        attemptInflation: null,
        latency: { p50: null, p95: null, sample: 0, overBudget: false },
        healthy: true, // No traffic = no problem (silently dropped from email)
      });
      continue;
    }
    let succeeded = 0, failed = 0, pending = 0, stuckPending = 0, totalAttempts = 0;
    const errorTally = new Map();
    // S134 — collect durations across all fired attempts (rate-limited
    // PENDING rows have durationMs=null and naturally skip).
    const durations = [];
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
      if (Number.isFinite(d.durationMs)) durations.push(d.durationMs);
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
    // S134 — p50/p95 latency. Below LATENCY_MIN_SAMPLE we report null
    // (one slow outlier swings small samples wildly; admin would chase
    // a non-issue). overBudget flips healthy=false too — slow-but-
    // working partners are still a signal worth surfacing.
    const latency = computeLatencyStats(durations);
    const healthy = failed === 0 && stuckPending === 0 && !latency.overBudget;
    rows.push({
      webhook: wh,
      totals: { total, succeeded, failed, pending, stuckPending, successRatePct },
      topError,
      attemptInflation,
      latency,
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

/**
 * Stage 134 — p50/p95 latency from a sample. Returns nulls + sample=0
 * below LATENCY_MIN_SAMPLE so a row with 1-2 outliers doesn't generate
 * a misleading percentile. Sort + nth element keeps it O(n log n) which
 * is fine at the typical sub-1k-rows-per-webhook-per-week scale.
 */
export function computeLatencyStats(durations) {
  const sample = durations.length;
  if (sample < LATENCY_MIN_SAMPLE) {
    return { p50: null, p95: null, sample, overBudget: false };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = (q) => Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  const p50 = sorted[idx(0.5)];
  const p95 = sorted[idx(0.95)];
  return {
    p50, p95, sample,
    overBudget: p95 > LATENCY_BUDGET_MS,
  };
}

export { LATENCY_BUDGET_MS, LATENCY_MIN_SAMPLE };
