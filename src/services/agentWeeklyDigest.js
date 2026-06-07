// Stage 36 — per-agent weekly digest. Mirror of S33 but scoped to one
// AgentProfile. Sent Monday ~07:10 so it lands after the OWNER digest
// (07:05) and the daily digest (07:00) — agents read theirs after the
// HQ leadership has read theirs.
//
// Each agent gets a personalised summary of their funnel + komisi for the
// previous Mon-Sun week, with vs-week-before deltas. Like S33 the window
// is Monday-anchored (Indonesian work-week).
//
// Idempotent: re-runs on the same Monday return the same numbers. The
// fan-out helper (`notifyAgentWeeklyDigest`) is responsible for one
// EMAIL row per active agent — same retry-on-failure posture as the
// OWNER digests.

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

const fmtRp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveLastFullWeek(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const thisMon = new Date(today.getTime() - dow * ONE_DAY_MS);
  const start = new Date(thisMon.getTime() - 7 * ONE_DAY_MS);
  const end = new Date(thisMon.getTime());
  const dStart = start.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const lastDayInclusive = new Date(end.getTime() - ONE_DAY_MS);
  const dEnd = lastDayInclusive.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  return { start, end, label: `${dStart} – ${dEnd}` };
}

const REVERSE_POLARITY = new Set(['cancelledBookings', 'leadsLost']);

function computeDelta(metricKey, current, previous) {
  const diff = current - previous;
  const reverse = REVERSE_POLARITY.has(metricKey);
  let direction = 'flat';
  if (diff > 0) direction = 'up';
  else if (diff < 0) direction = 'down';
  let good = null;
  if (direction === 'up') good = !reverse;
  else if (direction === 'down') good = reverse;
  const empty = current === 0 && previous === 0;
  let pct = null;
  if (previous !== 0) pct = Math.round((diff / previous) * 100);
  return { diff, pct, direction, good, empty };
}

async function aggregateAgentWeek({ agentId, start, end }) {
  const [
    newBookings,
    lunasBookings,
    cancelledBookings,
    leadsCreated,
    leadsConverted,
    leadsLost,
    komisiEarned,
    komisiPaid,
  ] = await Promise.all([
    db.booking.findMany({
      where: { agentId, createdAt: { gte: start, lt: end } },
      select: { id: true, totalAmount: true, paketId: true },
    }),
    db.booking.findMany({
      where: { agentId, status: 'LUNAS', updatedAt: { gte: start, lt: end } },
      select: { id: true, totalAmount: true, paketId: true },
    }),
    db.booking.count({
      where: { agentId, status: 'CANCELLED', cancelledAt: { gte: start, lt: end } },
    }),
    db.lead.count({
      where: { agentId, deletedAt: null, createdAt: { gte: start, lt: end } },
    }),
    db.lead.count({
      where: { agentId, status: 'CONVERTED', updatedAt: { gte: start, lt: end } },
    }),
    db.lead.count({
      where: { agentId, status: 'LOST', updatedAt: { gte: start, lt: end } },
    }),
    db.komisi.findMany({
      where: { agentId, earnedAt: { gte: start, lt: end } },
      select: { amount: true },
    }),
    db.komisiPayout.findMany({
      where: { agentId, paidAt: { gte: start, lt: end } },
      select: { amount: true },
    }),
  ]);

  const lunasRevenueIdr = lunasBookings.reduce(
    (acc, b) => acc + (toNumber(b.totalAmount) ?? 0),
    0,
  );
  const komisiEarnedIdr = komisiEarned.reduce(
    (acc, k) => acc + (toNumber(k.amount) ?? 0),
    0,
  );
  const komisiPaidIdr = komisiPaid.reduce(
    (acc, k) => acc + (toNumber(k.amount) ?? 0),
    0,
  );

  // Top paket sold this week (by new-booking count) — same idea as S33's
  // topPaket but agent-scoped.
  const topMap = new Map();
  for (const b of newBookings) {
    if (!b.paketId) continue;
    topMap.set(b.paketId, (topMap.get(b.paketId) || 0) + 1);
  }
  const topRaw = [...topMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return {
    counts: {
      newBookings: newBookings.length,
      lunasBookings: lunasBookings.length,
      cancelledBookings,
      leadsCreated,
      leadsConverted,
      leadsLost,
    },
    money: {
      lunasRevenueIdr,
      komisiEarnedIdr,
      komisiPaidIdr,
    },
    topRaw,
  };
}

async function attachPaketTitles(topRaw) {
  if (topRaw.length === 0) return [];
  const ids = topRaw.map(([id]) => id);
  const paket = await db.paket.findMany({
    where: { id: { in: ids } },
    select: { id: true, slug: true, title: true },
  });
  const byId = new Map(paket.map((p) => [p.id, p]));
  return topRaw.map(([id, count]) => ({ paket: byId.get(id) || null, count }));
}

/**
 * Build a per-agent weekly digest for the most recent complete Mon-Sun
 * + week-before for comparison. Returns null when the agent doesn't exist
 * or is soft-deleted (caller should skip the fan-out for them).
 */
export async function buildAgentWeeklyDigest({ agentId, now = new Date() } = {}) {
  if (!agentId) return null;
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: {
      id: true, slug: true, displayName: true,
      user: { select: { fullName: true, email: true, status: true, deletedAt: true } },
    },
  });
  if (!agent || !agent.user || agent.user.status !== 'ACTIVE' || agent.user.deletedAt) return null;

  const last = resolveLastFullWeek(now);
  const prevStart = new Date(last.start.getTime() - ONE_WEEK_MS);
  const prevEnd = new Date(last.start.getTime());

  const [current, previous] = await Promise.all([
    aggregateAgentWeek({ agentId, start: last.start, end: last.end }),
    aggregateAgentWeek({ agentId, start: prevStart, end: prevEnd }),
  ]);

  const topPaket = await attachPaketTitles(current.topRaw);

  const conversionPct = current.counts.leadsCreated > 0
    ? Math.round((current.counts.leadsConverted / current.counts.leadsCreated) * 100)
    : null;

  const deltas = {
    newBookings:       computeDelta('newBookings',       current.counts.newBookings,       previous.counts.newBookings),
    lunasBookings:     computeDelta('lunasBookings',     current.counts.lunasBookings,     previous.counts.lunasBookings),
    cancelledBookings: computeDelta('cancelledBookings', current.counts.cancelledBookings, previous.counts.cancelledBookings),
    leadsCreated:      computeDelta('leadsCreated',      current.counts.leadsCreated,      previous.counts.leadsCreated),
    leadsConverted:    computeDelta('leadsConverted',    current.counts.leadsConverted,    previous.counts.leadsConverted),
    leadsLost:         computeDelta('leadsLost',         current.counts.leadsLost,         previous.counts.leadsLost),
    lunasRevenueIdr:   computeDelta('lunasRevenueIdr',   current.money.lunasRevenueIdr,    previous.money.lunasRevenueIdr),
    komisiEarnedIdr:   computeDelta('komisiEarnedIdr',   current.money.komisiEarnedIdr,    previous.money.komisiEarnedIdr),
    komisiPaidIdr:     computeDelta('komisiPaidIdr',     current.money.komisiPaidIdr,      previous.money.komisiPaidIdr),
  };

  return {
    agent,
    label: last.label,
    weekStart: localYmd(last.start),
    weekEnd: localYmd(last.end),
    counts: { ...current.counts, conversionPct },
    money: current.money,
    previous,
    deltas,
    topPaket,
    fmt: {
      newBookings: fmtNum(current.counts.newBookings),
      lunasBookings: fmtNum(current.counts.lunasBookings),
      cancelledBookings: fmtNum(current.counts.cancelledBookings),
      leadsCreated: fmtNum(current.counts.leadsCreated),
      leadsConverted: fmtNum(current.counts.leadsConverted),
      leadsLost: fmtNum(current.counts.leadsLost),
      conversionPct: conversionPct == null ? '—' : `${conversionPct}%`,
      lunasRevenue: fmtRp(current.money.lunasRevenueIdr),
      komisiEarned: fmtRp(current.money.komisiEarnedIdr),
      komisiPaid: fmtRp(current.money.komisiPaidIdr),
    },
  };
}

/**
 * Helper for the cron job: list every ACTIVE agent so the caller can
 * iterate. Soft-deleted users are excluded; agents without an email are
 * also excluded (no inbox to send to).
 */
export async function listActiveAgentsForDigest() {
  return db.agentProfile.findMany({
    where: {
      user: { status: 'ACTIVE', deletedAt: null, email: { not: '' } },
    },
    select: {
      id: true, slug: true, displayName: true,
      user: { select: { email: true, fullName: true } },
    },
  });
}
