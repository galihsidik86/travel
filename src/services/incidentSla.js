// Stage 83 — incident response SLA report. Per-week aggregation:
//
//   - incidentsCreated      total incidents whose createdAt fell in the window
//   - ackedCount            of those, how many have a non-null ackedAt
//   - resolvedCount         of those, how many have a non-null resolvedAt
//   - escalatedCount        of those, how many tripped the S80 60min auto-escalate
//   - ackMs / resolveMs     percentile latency from createdAt → first ack /
//                           createdAt → resolved (only over acked / resolved rows)
//   - escalationRatePct     escalatedCount ÷ incidentsCreated × 100
//
// Cohorts by WEEK OF CREATEDAT — fast-resolved incidents count in the week
// they were CREATED, not the week they were resolved, because the question is
// "how responsive were we to incidents that arrived in week X" (response
// latency is a property of the incident, not the resolution date).
//
// Open-but-aging rows: include them in `incidentsCreated` (denominator) but
// not in the percentile pool — `p95ResolveMs` over only-resolved incidents
// is honest; mixing unresolved (nulls) in would distort the number.
import { db } from '../lib/db.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// Monday-anchored week boundary in local TZ — matches the OWNER/agent
// weekly digests (S33, S36) so admins reading both reports use the same
// mental calendar.
// Local-TZ YMD — `toISOString().slice(0,10)` lands on the previous calendar
// day for any local time before UTC midnight (Asia/Jakarta = UTC+7 → local
// Monday midnight is UTC Sunday 17:00). Same bug bit the daily digest; see
// CLAUDE.md S33 note about `localYmd` in weeklyDigest.
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeekMonday(d) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = out.getDay();              // Sun=0 … Sat=6
  const shift = dow === 0 ? -6 : (1 - dow); // back to Monday
  out.setDate(out.getDate() + shift);
  out.setHours(0, 0, 0, 0);
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  // Linear interpolation between two nearest ranks.
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return Math.round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

function fmtDurationMs(ms) {
  if (ms == null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m ? `${h}j ${m}m` : `${h}j`;
  }
  const d = Math.floor(ms / MS_PER_DAY);
  const h = Math.round((ms % MS_PER_DAY) / 3_600_000);
  return h ? `${d}h ${h}j` : `${d}h`;
}

function fmtWeekLabel(start) {
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${fmt(start)}–${fmt(end)}`;
}

/**
 * @param {object} opts
 * @param {number} [opts.weeks=8] number of completed weeks to report (latest first)
 * @param {Date}   [opts.now]
 */
export async function getIncidentSlaReport({ weeks = 8, now = new Date() } = {}) {
  const safeWeeks = Math.min(Math.max(parseInt(weeks, 10) || 8, 1), 52);

  // Window: last `safeWeeks` complete Mon-Sun weeks ending at the start
  // of THIS week (current week excluded — it's still accumulating).
  const thisWeekStart = startOfWeekMonday(now);
  const oldestWeekStart = new Date(thisWeekStart.getTime() - safeWeeks * MS_PER_WEEK);

  const incidents = await db.incident.findMany({
    where: { createdAt: { gte: oldestWeekStart, lt: thisWeekStart } },
    select: {
      id: true, createdAt: true, ackedAt: true, resolvedAt: true, escalatedAt: true,
      type: true, status: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Bucket by week-start (Monday)
  const buckets = new Map();   // key = startMs → { ... }
  for (let i = 0; i < safeWeeks; i += 1) {
    const start = new Date(oldestWeekStart.getTime() + i * MS_PER_WEEK);
    buckets.set(start.getTime(), {
      start, label: fmtWeekLabel(start),
      created: 0, acked: 0, resolved: 0, escalated: 0,
      ackMs: [], resolveMs: [],
    });
  }
  for (const inc of incidents) {
    const start = startOfWeekMonday(inc.createdAt);
    const b = buckets.get(start.getTime());
    if (!b) continue;
    b.created += 1;
    if (inc.ackedAt) {
      b.acked += 1;
      b.ackMs.push(inc.ackedAt.getTime() - inc.createdAt.getTime());
    }
    if (inc.resolvedAt) {
      b.resolved += 1;
      b.resolveMs.push(inc.resolvedAt.getTime() - inc.createdAt.getTime());
    }
    if (inc.escalatedAt) b.escalated += 1;
  }

  const rows = Array.from(buckets.values())
    .sort((a, z) => z.start.getTime() - a.start.getTime())  // newest first
    .map((b) => {
      const ackSorted = b.ackMs.slice().sort((a, z) => a - z);
      const resolveSorted = b.resolveMs.slice().sort((a, z) => a - z);
      const ackP50 = percentile(ackSorted, 50);
      const ackP95 = percentile(ackSorted, 95);
      const resolveP50 = percentile(resolveSorted, 50);
      const resolveP95 = percentile(resolveSorted, 95);
      const escalationRatePct = b.created > 0
        ? Math.round((b.escalated / b.created) * 1000) / 10  // 1 dp
        : null;
      return {
        weekStart: localYmd(b.start),
        label: b.label,
        created: b.created,
        acked: b.acked,
        resolved: b.resolved,
        escalated: b.escalated,
        ackP50, ackP95, resolveP50, resolveP95,
        escalationRatePct,
        fmt: {
          ackP50: fmtDurationMs(ackP50),
          ackP95: fmtDurationMs(ackP95),
          resolveP50: fmtDurationMs(resolveP50),
          resolveP95: fmtDurationMs(resolveP95),
        },
      };
    });

  // Totals across the window — for the panel header KPI strip.
  const allAck = rows.flatMap((r, _, arr) => arr).reduce(() => [], []); // placeholder
  const totalCreated = rows.reduce((s, r) => s + r.created, 0);
  const totalAcked = rows.reduce((s, r) => s + r.acked, 0);
  const totalResolved = rows.reduce((s, r) => s + r.resolved, 0);
  const totalEscalated = rows.reduce((s, r) => s + r.escalated, 0);

  // Window-wide percentiles need the full sample, not a percentile of
  // weekly percentiles (which would smear the signal).
  const allAckMs = incidents
    .filter((i) => i.ackedAt)
    .map((i) => i.ackedAt.getTime() - i.createdAt.getTime())
    .sort((a, z) => a - z);
  const allResolveMs = incidents
    .filter((i) => i.resolvedAt)
    .map((i) => i.resolvedAt.getTime() - i.createdAt.getTime())
    .sort((a, z) => a - z);

  return {
    weeks: safeWeeks,
    window: {
      from: localYmd(oldestWeekStart),
      to: localYmd(new Date(thisWeekStart.getTime() - 1)),
    },
    rows,
    totals: {
      created: totalCreated,
      acked: totalAcked,
      resolved: totalResolved,
      escalated: totalEscalated,
      ackP50: percentile(allAckMs, 50),
      ackP95: percentile(allAckMs, 95),
      resolveP50: percentile(allResolveMs, 50),
      resolveP95: percentile(allResolveMs, 95),
      escalationRatePct: totalCreated > 0
        ? Math.round((totalEscalated / totalCreated) * 1000) / 10
        : null,
      fmt: {
        ackP50: fmtDurationMs(percentile(allAckMs, 50)),
        ackP95: fmtDurationMs(percentile(allAckMs, 95)),
        resolveP50: fmtDurationMs(percentile(allResolveMs, 50)),
        resolveP95: fmtDurationMs(percentile(allResolveMs, 95)),
      },
    },
  };
}

// Exported for tests
export { percentile, startOfWeekMonday, fmtDurationMs };
