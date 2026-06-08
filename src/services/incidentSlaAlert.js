// Stage 87 — per-type SLA budgets + breach detection.
//
// S83 measures; S87 alerts. The two are deliberately separate services so
// the report stays read-only + cheap to render, while the alert can fire
// on a different cadence (weekly vs on-demand render).
//
// Budgets are constants here (not DB-backed) because:
//   - There's exactly one set of correct numbers for "how fast should
//     SOS be acked", and we don't want every admin tweaking it
//   - DB-backed config would need its own UI + audit + RBAC, all of
//     which would dwarf the actual benefit
// If a budget needs to change later, edit this file + ship — same
// discipline as a code change to any other invariant.
import { db } from '../lib/db.js';

const ONE_MIN_MS = 60_000;
const MS_PER_DAY = 86_400_000;

// SLA budgets per IncidentType. Tighter for life-safety, looser for
// admin/ops. Numbers chosen to mirror typical commercial response
// targets — should be revisited if real-world p95 stays comfortably
// below them for 3 months (over-budgeted) or stays above (under-budgeted).
export const SLA_BUDGETS = {
  SOS:         { ackMs: 5 * ONE_MIN_MS,   resolveMs: 30 * ONE_MIN_MS },
  MEDICAL:     { ackMs: 15 * ONE_MIN_MS,  resolveMs: 60 * ONE_MIN_MS },
  LOST_JEMAAH: { ackMs: 30 * ONE_MIN_MS,  resolveMs: 4 * 60 * ONE_MIN_MS },
  SECURITY:    { ackMs: 60 * ONE_MIN_MS,  resolveMs: 24 * 60 * ONE_MIN_MS },
  LOGISTICAL:  { ackMs: 2 * 60 * ONE_MIN_MS, resolveMs: 48 * 60 * ONE_MIN_MS },
  OTHER:       { ackMs: 2 * 60 * ONE_MIN_MS, resolveMs: 48 * 60 * ONE_MIN_MS },
};

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return Math.round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m ? `${h}j ${m}m` : `${h}j`;
  }
  return `${Math.round(ms / MS_PER_DAY)}h`;
}

function startOfWeekMonday(d) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = out.getDay();
  const shift = dow === 0 ? -6 : (1 - dow);
  out.setDate(out.getDate() + shift);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Find SLA breaches for the previous *complete* Mon-Sun week.
 *
 * Returns one row per (type, metric) where the observed p95 exceeded the
 * budget. Metric ∈ {ack, resolve}. Types with <3 samples in the window
 * are skipped — too few to make a statistical claim. Types whose p95 is
 * inside budget are also skipped (silent on healthy weeks).
 *
 * Empty `rows` means "nothing breached" → the caller's notify helper
 * stays silent. Same posture as S46/S53.
 */
export async function getIncidentSlaBreaches({ now = new Date(), minSample = 3 } = {}) {
  const thisWeekStart = startOfWeekMonday(now);
  const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * MS_PER_DAY);

  const incidents = await db.incident.findMany({
    where: { createdAt: { gte: prevWeekStart, lt: thisWeekStart } },
    select: {
      id: true, type: true, createdAt: true,
      ackedAt: true, resolvedAt: true,
    },
  });

  // Group by type
  const byType = new Map();   // type → { ackMs[], resolveMs[] }
  for (const inc of incidents) {
    if (!byType.has(inc.type)) byType.set(inc.type, { ackMs: [], resolveMs: [], total: 0 });
    const bucket = byType.get(inc.type);
    bucket.total += 1;
    if (inc.ackedAt) bucket.ackMs.push(inc.ackedAt.getTime() - inc.createdAt.getTime());
    if (inc.resolvedAt) bucket.resolveMs.push(inc.resolvedAt.getTime() - inc.createdAt.getTime());
  }

  const rows = [];
  for (const [type, bucket] of byType) {
    const budget = SLA_BUDGETS[type];
    if (!budget) continue;

    // ack budget
    if (bucket.ackMs.length >= minSample) {
      const sorted = bucket.ackMs.slice().sort((a, z) => a - z);
      const p95 = percentile(sorted, 95);
      if (p95 != null && p95 > budget.ackMs) {
        rows.push({
          type,
          metric: 'ack',
          p95,
          budget: budget.ackMs,
          sample: bucket.ackMs.length,
          overByMs: p95 - budget.ackMs,
          overByPct: Math.round((p95 / budget.ackMs - 1) * 100),
          fmt: { p95: fmtDur(p95), budget: fmtDur(budget.ackMs), overBy: fmtDur(p95 - budget.ackMs) },
        });
      }
    }
    // resolve budget
    if (bucket.resolveMs.length >= minSample) {
      const sorted = bucket.resolveMs.slice().sort((a, z) => a - z);
      const p95 = percentile(sorted, 95);
      if (p95 != null && p95 > budget.resolveMs) {
        rows.push({
          type,
          metric: 'resolve',
          p95,
          budget: budget.resolveMs,
          sample: bucket.resolveMs.length,
          overByMs: p95 - budget.resolveMs,
          overByPct: Math.round((p95 / budget.resolveMs - 1) * 100),
          fmt: { p95: fmtDur(p95), budget: fmtDur(budget.resolveMs), overBy: fmtDur(p95 - budget.resolveMs) },
        });
      }
    }
  }

  // Sort: most-overshot first (overByPct desc), so the worst breach
  // lands at the top of the email body.
  rows.sort((a, b) => b.overByPct - a.overByPct);

  return {
    window: {
      from: prevWeekStart.toISOString().slice(0, 10),
      to: new Date(thisWeekStart.getTime() - 1).toISOString().slice(0, 10),
    },
    rows,
    counts: {
      breaches: rows.length,
      incidentsTotal: incidents.length,
    },
  };
}

export { percentile, fmtDur, startOfWeekMonday };
