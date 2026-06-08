// runJob — thin wrapper that records every ops-job invocation to JobRun.
//
// Why a wrapper instead of recording inside each service? Tests call the
// services directly; we don't want fixture noise polluting the freshness
// log. Production paths (CLI cron scripts + HTTP triggers) go through
// runJob, dev tests don't. Same service function, two arrival paths.
//
// The wrapper:
//   1. inserts a "started" row immediately so a hung job is still visible
//   2. awaits fn() — expected return shape: { scanned, expired/sent/affected, errors, ...detail }
//   3. patches the row with ok=true + counters + durationMs
//   4. on throw: patches with ok=false + error message, re-throws
//
// Job result shape convention: the service can return any object; runJob
// pulls `scanned`, `affected` (mapped from `expired`/`sent` if present),
// `errors` (count or array.length) into top-level cols, stashes the rest
// in `detail`. Anything outside that envelope still surfaces to the caller.
import { db } from './db.js';

function deriveCounters(result) {
  const r = result || {};
  const scanned = r.scanned ?? null;
  const affected = r.affected ?? r.expired ?? r.sent ?? null;
  const errs = Array.isArray(r.errors) ? r.errors.length : (typeof r.errors === 'number' ? r.errors : 0);
  // Detail = everything except the dedicated columns
  const detail = { ...r };
  delete detail.scanned; delete detail.affected; delete detail.expired; delete detail.sent; delete detail.errors;
  return {
    scanned, affected, errors: errs,
    detail: Object.keys(detail).length ? detail : null,
  };
}

/**
 * Run a job, recording start + finish in JobRun. Re-throws any error.
 * Pass an optional `db` arg for tests; defaults to the singleton client.
 */
export async function runJob(name, fn, { dbClient = db } = {}) {
  const started = await dbClient.jobRun.create({
    data: { name, startedAt: new Date(), ok: false },
  });
  const t0 = Date.now();
  try {
    const result = await fn();
    const counters = deriveCounters(result);
    const finishedAt = new Date();
    await dbClient.jobRun.update({
      where: { id: started.id },
      data: {
        finishedAt, ok: true,
        durationMs: finishedAt.getTime() - t0,
        ...counters,
      },
    });
    return result;
  } catch (err) {
    const finishedAt = new Date();
    await dbClient.jobRun.update({
      where: { id: started.id },
      data: {
        finishedAt, ok: false,
        durationMs: finishedAt.getTime() - t0,
        error: err.message?.slice(0, 2000) || String(err),
      },
    }).catch(() => { /* never let the recorder hide the underlying error */ });
    throw err;
  }
}

// Expected interval (ms) per job — drives "stale" flag on /api/health.
// Allow ~2× the configured cron cadence before flagging.
export const EXPECTED_INTERVAL_MS = {
  'expire-docs': 24 * 60 * 60_000,        // daily
  'expire-intents': 10 * 60_000,          // every 10 min
  'send-notifications': 2 * 60_000,       // every 2 min
  'send-daily-digest': 24 * 60 * 60_000,  // daily (Stage 27)
  'send-weekly-digest': 7 * 24 * 60 * 60_000, // weekly (Stage 33)
  'send-agent-weekly-digest': 7 * 24 * 60 * 60_000, // weekly (Stage 36)
  'send-payout-reminder': 7 * 24 * 60 * 60_000, // weekly (Stage 37)
  'send-stalled-leads': 24 * 60 * 60_000, // daily (Stage 46)
  'send-traffic-anomaly': 24 * 60 * 60_000, // daily (Stage 53)
  'send-landing-slow': 24 * 60 * 60_000, // daily (Stage 58)
  'send-crew-weekly-digest': 7 * 24 * 60 * 60_000, // weekly (Stage 65)
  'send-incident-escalate': 15 * 60_000, // every 15 min (Stage 80) — 60min threshold means tight cadence pays off
  'prune': 7 * 24 * 60 * 60_000,          // weekly — bounded-growth pass
};

/**
 * Per-job freshness snapshot for /api/health. Returns one row per known job
 * name with the latest successful run (if any) + an `ok` flag derived from
 * "age <= 2 × expected interval".
 */
export async function getJobFreshness({ dbClient = db } = {}) {
  const names = Object.keys(EXPECTED_INTERVAL_MS);
  const now = Date.now();
  // One query per job — small N, simpler than a window function.
  const rows = await Promise.all(names.map(async (name) => {
    const latest = await dbClient.jobRun.findFirst({
      where: { name, ok: true, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true, durationMs: true, scanned: true, affected: true, errors: true },
    });
    if (!latest) {
      return { name, ok: false, ranEver: false, expectedIntervalSec: EXPECTED_INTERVAL_MS[name] / 1000 };
    }
    const ageMs = now - latest.finishedAt.getTime();
    const expected = EXPECTED_INTERVAL_MS[name];
    return {
      name,
      ok: ageMs <= expected * 2,
      ranEver: true,
      lastSuccessAt: latest.finishedAt.toISOString(),
      ageSeconds: Math.floor(ageMs / 1000),
      expectedIntervalSec: expected / 1000,
      lastDurationMs: latest.durationMs,
      lastScanned: latest.scanned,
      lastAffected: latest.affected,
      lastErrors: latest.errors,
    };
  }));
  return rows;
}
