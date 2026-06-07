// Stage 27 — daily activity digest for OWNER (email).
//
// Runs ~07:00 every morning, aggregates "what happened yesterday" + a
// running 7-day comparison so owner can read one email instead of
// logging into /admin every day. Sources are deliberately the SAME ones
// the dashboard reads — no separate counters or denormalised state.
//
// Returns a `vars` object the renderTemplate() pipeline embeds straight
// into the email body; the caller (`notifyDailyDigest`) handles the
// fan-out to every ACTIVE OWNER user.
//
// Idempotent: re-running for the same date returns the same numbers.
// The notify caller is responsible for not double-sending — the cron
// runs once per day and `runJob()` records each invocation.

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const MS_PER_DAY = 86_400_000;

const fmtRp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');

/**
 * Resolve the calendar window for "yesterday" in local time. Pass a
 * `now` instance from caller (test fixture) for deterministic windows;
 * defaults to wall-clock now.
 *
 * Returns { dayStart, dayEnd, label } where label is e.g. "1 Juni 2026".
 */
function resolveYesterday(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);              // start of today
  const start = new Date(end.getTime() - MS_PER_DAY); // start of yesterday
  const label = start.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  return { dayStart: start, dayEnd: end, label };
}

/**
 * Build a digest payload for the calendar day immediately before `now`.
 * All counts are deliberately conservative: cancelled bookings still
 * count in "bookings baru" (they reflect intent that day), only LUNAS
 * revenue counts in "revenue masuk" (the money actually realised).
 */
export async function buildDailyDigest({ now = new Date() } = {}) {
  const { dayStart, dayEnd, label } = resolveYesterday(now);
  const weekAgo = new Date(dayStart.getTime() - 6 * MS_PER_DAY);

  const [
    newBookings,
    lunasBookings,
    paymentsIn,
    refundsOut,
    newJemaah,
    newLeads,
    incidentsCreated,
    incidentsOpen,
    komisiEarned,
    komisiPaid,
    weekBookings,
    weekLunasBookings,
  ] = await Promise.all([
    db.booking.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, status: true, totalAmount: true, paket: { select: { title: true } } },
    }),
    db.booking.findMany({
      where: {
        status: 'LUNAS',
        updatedAt: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true, totalAmount: true },
    }),
    db.payment.findMany({
      where: { status: 'PAID', paidAt: { gte: dayStart, lt: dayEnd } },
      select: { amount: true, currency: true },
    }),
    db.payment.findMany({
      where: { status: 'REFUNDED', createdAt: { gte: dayStart, lt: dayEnd } },
      select: { amount: true },
    }),
    db.jemaahProfile.count({ where: { bookings: { some: { createdAt: { gte: dayStart, lt: dayEnd } } } } }),
    db.lead.count({ where: { deletedAt: null, createdAt: { gte: dayStart, lt: dayEnd } } }),
    db.incident.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),
    db.incident.count({ where: { status: 'OPEN' } }),
    db.komisi.findMany({
      where: { earnedAt: { gte: dayStart, lt: dayEnd } },
      select: { amount: true },
    }),
    db.komisiPayout.findMany({
      where: { paidAt: { gte: dayStart, lt: dayEnd } },
      select: { amount: true },
    }),
    // 7-day windows for the "vs last 7 days" line
    db.booking.count({ where: { createdAt: { gte: weekAgo, lt: dayEnd } } }),
    db.booking.count({ where: { status: 'LUNAS', updatedAt: { gte: weekAgo, lt: dayEnd } } }),
  ]);

  // Currency aggregation is IDR-only for the digest line — owner reads
  // one number. Non-IDR cash is rare in this system, and including it
  // would make the line confusing rather than complete.
  const paymentsInIdr = paymentsIn
    .filter((p) => (p.currency || 'IDR') === 'IDR')
    .reduce((acc, p) => acc + (toNumber(p.amount) ?? 0), 0);
  const refundsOutIdr = refundsOut.reduce((acc, p) => acc + Math.abs(toNumber(p.amount) ?? 0), 0);
  const lunasRevenueIdr = lunasBookings.reduce((acc, b) => acc + (toNumber(b.totalAmount) ?? 0), 0);
  const komisiEarnedIdr = komisiEarned.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);
  const komisiPaidIdr = komisiPaid.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);

  const bookingsByStatus = newBookings.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {});

  return {
    date: dayStart.toISOString().slice(0, 10),
    label,
    counts: {
      newBookings: newBookings.length,
      lunasBookings: lunasBookings.length,
      newJemaah,
      newLeads,
      incidentsCreated,
      incidentsOpen,
      bookingsByStatus,
    },
    money: {
      paymentsInIdr,
      refundsOutIdr,
      lunasRevenueIdr,
      komisiEarnedIdr,
      komisiPaidIdr,
      netRevenueIdr: paymentsInIdr - refundsOutIdr,
    },
    week: {
      bookings: weekBookings,
      lunasBookings: weekLunasBookings,
    },
    fmt: {
      newBookings: fmtNum(newBookings.length),
      lunasBookings: fmtNum(lunasBookings.length),
      newJemaah: fmtNum(newJemaah),
      newLeads: fmtNum(newLeads),
      incidentsCreated: fmtNum(incidentsCreated),
      incidentsOpen: fmtNum(incidentsOpen),
      paymentsIn: fmtRp(paymentsInIdr),
      refundsOut: fmtRp(refundsOutIdr),
      lunasRevenue: fmtRp(lunasRevenueIdr),
      komisiEarned: fmtRp(komisiEarnedIdr),
      komisiPaid: fmtRp(komisiPaidIdr),
      netRevenue: fmtRp(paymentsInIdr - refundsOutIdr),
    },
  };
}

// Metric polarity for delta colouring. Default = "higher is better"; the
// metrics listed here are reversed (more refunds / more incidents is *worse*).
// `incidentsOpen` is a snapshot (not a window-delta candidate) so it's not
// in the comparable set — but if added later it would also be REVERSE.
const REVERSE_POLARITY = new Set(['refundsOutIdr', 'incidentsCreated']);

/**
 * Compute a signed day-over-day delta for one metric.
 *   - diff:      current − previous
 *   - pct:       round((diff / previous) * 100); null when previous=0 AND current>0
 *                (we render "+N" instead so the "% of zero" trap doesn't lie)
 *   - direction: 'up' | 'down' | 'flat'
 *   - good:      true when the direction is favourable for this metric
 *                (reverse polarity flips the meaning)
 *   - empty:     true when both windows are zero — render as "—" rather than 0%
 */
function computeDelta(metricKey, current, previous) {
  const diff = current - previous;
  const reverse = REVERSE_POLARITY.has(metricKey);
  let direction = 'flat';
  if (diff > 0) direction = 'up';
  else if (diff < 0) direction = 'down';

  // Forward polarity: up=good. Reverse polarity: down=good.
  let good = null;
  if (direction === 'up') good = !reverse;
  else if (direction === 'down') good = reverse;
  // flat stays null — neither good nor bad, render as neutral

  const empty = current === 0 && previous === 0;
  let pct = null;
  if (previous !== 0) pct = Math.round((diff / previous) * 100);
  // previous=0, current>0 → pct stays null; the view picks "+N" instead

  return { diff, pct, direction, good, empty };
}

/**
 * Stage 29 — paired digest with day-over-day deltas. Calls `buildDailyDigest`
 * twice (yesterday + day-before) and adds a `deltas` map keyed by metric so
 * the widget can render arrows + percentages without reaching into raw counts.
 *
 * Why both windows go through `buildDailyDigest` and not a custom query: the
 * windowing rules (LUNAS counts updatedAt, payments count paidAt, etc.) are
 * already encoded once. Replicating them risks drift between the two surfaces.
 */
export async function buildDigestWithComparison({ now = new Date() } = {}) {
  const current = await buildDailyDigest({ now });
  const previousNow = new Date(now.getTime() - MS_PER_DAY);
  const previous = await buildDailyDigest({ now: previousNow });

  const deltas = {
    newBookings:      computeDelta('newBookings',      current.counts.newBookings,      previous.counts.newBookings),
    lunasBookings:    computeDelta('lunasBookings',    current.counts.lunasBookings,    previous.counts.lunasBookings),
    newJemaah:        computeDelta('newJemaah',        current.counts.newJemaah,        previous.counts.newJemaah),
    newLeads:         computeDelta('newLeads',         current.counts.newLeads,         previous.counts.newLeads),
    incidentsCreated: computeDelta('incidentsCreated', current.counts.incidentsCreated, previous.counts.incidentsCreated),
    lunasRevenueIdr:  computeDelta('lunasRevenueIdr',  current.money.lunasRevenueIdr,   previous.money.lunasRevenueIdr),
    paymentsInIdr:    computeDelta('paymentsInIdr',    current.money.paymentsInIdr,     previous.money.paymentsInIdr),
    refundsOutIdr:    computeDelta('refundsOutIdr',    current.money.refundsOutIdr,     previous.money.refundsOutIdr),
    netRevenueIdr:    computeDelta('netRevenueIdr',    current.money.netRevenueIdr,     previous.money.netRevenueIdr),
    komisiEarnedIdr:  computeDelta('komisiEarnedIdr',  current.money.komisiEarnedIdr,   previous.money.komisiEarnedIdr),
    komisiPaidIdr:    computeDelta('komisiPaidIdr',    current.money.komisiPaidIdr,     previous.money.komisiPaidIdr),
  };

  return { ...current, previous, deltas };
}

/**
 * Stage 31 — bundle the digest + needs-attention payload so the CLI / HTTP
 * trigger and the email template can read both off one object. Same failure
 * posture as buildDigestWithComparison — needs-attention failure is non-
 * fatal; the digest still goes out, the block just renders empty.
 */
export async function buildDigestWithAttention({ now = new Date() } = {}) {
  const digest = await buildDigestWithComparison({ now });
  let needsAttention = null;
  try {
    const { getNeedsAttention } = await import('./needsAttention.js');
    needsAttention = await getNeedsAttention({ now });
  } catch (err) {
    console.warn('[daily-digest] getNeedsAttention failed:', err?.message || err);
  }
  return { ...digest, needsAttention };
}
