// Stage 33 — weekly summary digest for OWNER. Runs Monday ~07:00 local
// time and aggregates the previous full week (Mon–Sun by default since
// users see the work-week as Monday-anchored), with a vs-week-before
// comparison so trends are visible.
//
// Like the daily digest, sources are deliberately the same ones /admin
// reads. The weekly is NOT a sum of dailies — it queries the week
// directly, so a single transactional state (e.g. a refund posted at the
// edge of a day) doesn't double-count.
//
// Idempotent: re-running for the same Monday returns the same numbers.
// The fan-out caller is responsible for not double-sending (cron fires
// once per week; runJob records each invocation).

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

const fmtRp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');

/**
 * Local-date `YYYY-MM-DD` string. Using `.toISOString().slice(0,10)` on a
 * local-midnight Date yields the *previous* UTC day in any +TZ — we want
 * the label and the field to agree, so compute from local components.
 */
function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve the calendar window for "the previous full Monday-to-Sunday
 * week" relative to `now`. Conventions:
 *   - week starts Monday 00:00 local
 *   - returned start is the *previous* Monday (so on Mon morning, that's
 *     the Mon of last week; on Tue, also last week's Mon — i.e. always
 *     the most recent *complete* Mon-Sun).
 *   - returned end is the following Monday 00:00 (exclusive)
 *
 * Saturday/Sunday firings: still resolve to the most-recent COMPLETED
 * Mon-Sun (= last week's Monday). This makes weekend re-runs idempotent
 * with the canonical Mon-AM run.
 */
function resolveLastFullWeek(now = new Date()) {
  // Today at 00:00 local
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Day of week: JS uses 0=Sun..6=Sat. Convert to 0=Mon..6=Sun.
  const dow = (today.getDay() + 6) % 7;
  // This Monday (start of current week)
  const thisMon = new Date(today.getTime() - dow * ONE_DAY_MS);
  // Last Monday (start of previous week)
  const start = new Date(thisMon.getTime() - 7 * ONE_DAY_MS);
  const end = new Date(thisMon.getTime());
  // Indonesian-friendly range label: "1–7 Juni 2026"
  const dStart = start.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const lastDayInclusive = new Date(end.getTime() - ONE_DAY_MS);
  const dEnd = lastDayInclusive.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  return { start, end, label: `${dStart} – ${dEnd}` };
}

async function aggregateWeek({ start, end }) {
  const [
    newBookings,
    lunasBookings,
    paymentsIn,
    refundsOut,
    newJemaah,
    newLeads,
    incidentsCreated,
    komisiEarned,
    komisiPaid,
    cancelledBookings,
    docsVerified,
  ] = await Promise.all([
    db.booking.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { id: true, status: true, totalAmount: true, paketId: true },
    }),
    db.booking.findMany({
      where: { status: 'LUNAS', updatedAt: { gte: start, lt: end } },
      select: { id: true, totalAmount: true, paketId: true },
    }),
    db.payment.findMany({
      where: { status: 'PAID', paidAt: { gte: start, lt: end } },
      select: { amount: true, currency: true },
    }),
    db.payment.findMany({
      where: { status: 'REFUNDED', createdAt: { gte: start, lt: end } },
      select: { amount: true },
    }),
    // JemaahProfile has no createdAt — mirror the daily digest pattern:
    // "jemaah whose first interaction (any booking) landed in the window".
    db.jemaahProfile.count({
      where: { bookings: { some: { createdAt: { gte: start, lt: end } } } },
    }),
    db.lead.count({
      where: { deletedAt: null, createdAt: { gte: start, lt: end } },
    }),
    db.incident.count({
      where: { createdAt: { gte: start, lt: end } },
    }),
    db.komisi.findMany({
      where: { earnedAt: { gte: start, lt: end } },
      select: { amount: true },
    }),
    db.komisiPayout.findMany({
      where: { paidAt: { gte: start, lt: end } },
      select: { amount: true },
    }),
    db.booking.count({
      where: { status: 'CANCELLED', cancelledAt: { gte: start, lt: end } },
    }),
    db.jemaahDocument.count({
      where: { status: 'VERIFIED', verifiedAt: { gte: start, lt: end } },
    }),
  ]);

  const paymentsInIdr = paymentsIn
    .filter((p) => (p.currency || 'IDR') === 'IDR')
    .reduce((acc, p) => acc + (toNumber(p.amount) ?? 0), 0);
  const refundsOutIdr = refundsOut.reduce((acc, p) => acc + Math.abs(toNumber(p.amount) ?? 0), 0);
  const lunasRevenueIdr = lunasBookings.reduce((acc, b) => acc + (toNumber(b.totalAmount) ?? 0), 0);
  const komisiEarnedIdr = komisiEarned.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);
  const komisiPaidIdr = komisiPaid.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);

  return {
    counts: {
      newBookings: newBookings.length,
      lunasBookings: lunasBookings.length,
      newJemaah,
      newLeads,
      incidentsCreated,
      cancelledBookings,
      docsVerified,
    },
    money: {
      paymentsInIdr,
      refundsOutIdr,
      lunasRevenueIdr,
      komisiEarnedIdr,
      komisiPaidIdr,
      netRevenueIdr: paymentsInIdr - refundsOutIdr,
    },
    // Top paket by new-booking count this week — surfaces "what's hot"
    topPaketByNewBookings: topByPaket(newBookings),
  };
}

function topByPaket(bookings) {
  const m = new Map();
  for (const b of bookings) {
    if (!b.paketId) continue;
    m.set(b.paketId, (m.get(b.paketId) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

/**
 * Resolve paket titles for the topPaketByNewBookings array so the email
 * doesn't render bare cuids. Cheap — at most 3 IDs per run.
 */
async function attachPaketTitles(top) {
  if (top.length === 0) return [];
  const ids = top.map(([id]) => id);
  const paket = await db.paket.findMany({
    where: { id: { in: ids } },
    select: { id: true, slug: true, title: true },
  });
  const byId = new Map(paket.map((p) => [p.id, p]));
  return top.map(([id, count]) => ({
    paket: byId.get(id) || null,
    count,
  }));
}

const REVERSE_POLARITY = new Set(['refundsOutIdr', 'incidentsCreated', 'cancelledBookings']);

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

/**
 * Build a weekly digest for the most recent complete Mon-Sun, plus the
 * week-before for comparison.
 */
export async function buildWeeklyDigest({ now = new Date() } = {}) {
  const last = resolveLastFullWeek(now);
  const prevStart = new Date(last.start.getTime() - ONE_WEEK_MS);
  const prevEnd = new Date(last.start.getTime());

  const [current, previous] = await Promise.all([
    aggregateWeek({ start: last.start, end: last.end }),
    aggregateWeek({ start: prevStart, end: prevEnd }),
  ]);

  const topPaket = await attachPaketTitles(current.topPaketByNewBookings);

  const deltas = {
    newBookings:       computeDelta('newBookings',       current.counts.newBookings,       previous.counts.newBookings),
    lunasBookings:     computeDelta('lunasBookings',     current.counts.lunasBookings,     previous.counts.lunasBookings),
    cancelledBookings: computeDelta('cancelledBookings', current.counts.cancelledBookings, previous.counts.cancelledBookings),
    newJemaah:         computeDelta('newJemaah',         current.counts.newJemaah,         previous.counts.newJemaah),
    newLeads:          computeDelta('newLeads',          current.counts.newLeads,          previous.counts.newLeads),
    incidentsCreated:  computeDelta('incidentsCreated',  current.counts.incidentsCreated,  previous.counts.incidentsCreated),
    docsVerified:      computeDelta('docsVerified',      current.counts.docsVerified,      previous.counts.docsVerified),
    lunasRevenueIdr:   computeDelta('lunasRevenueIdr',   current.money.lunasRevenueIdr,    previous.money.lunasRevenueIdr),
    paymentsInIdr:     computeDelta('paymentsInIdr',     current.money.paymentsInIdr,      previous.money.paymentsInIdr),
    refundsOutIdr:     computeDelta('refundsOutIdr',     current.money.refundsOutIdr,      previous.money.refundsOutIdr),
    netRevenueIdr:     computeDelta('netRevenueIdr',     current.money.netRevenueIdr,      previous.money.netRevenueIdr),
    komisiEarnedIdr:   computeDelta('komisiEarnedIdr',   current.money.komisiEarnedIdr,    previous.money.komisiEarnedIdr),
    komisiPaidIdr:     computeDelta('komisiPaidIdr',     current.money.komisiPaidIdr,      previous.money.komisiPaidIdr),
  };

  return {
    label: last.label,
    weekStart: localYmd(last.start),
    weekEnd: localYmd(last.end), // exclusive
    counts: current.counts,
    money: current.money,
    previous,
    deltas,
    topPaket,
    fmt: {
      newBookings: fmtNum(current.counts.newBookings),
      lunasBookings: fmtNum(current.counts.lunasBookings),
      cancelledBookings: fmtNum(current.counts.cancelledBookings),
      newJemaah: fmtNum(current.counts.newJemaah),
      newLeads: fmtNum(current.counts.newLeads),
      incidentsCreated: fmtNum(current.counts.incidentsCreated),
      docsVerified: fmtNum(current.counts.docsVerified),
      paymentsIn: fmtRp(current.money.paymentsInIdr),
      refundsOut: fmtRp(current.money.refundsOutIdr),
      lunasRevenue: fmtRp(current.money.lunasRevenueIdr),
      komisiEarned: fmtRp(current.money.komisiEarnedIdr),
      komisiPaid: fmtRp(current.money.komisiPaidIdr),
      netRevenue: fmtRp(current.money.netRevenueIdr),
    },
  };
}
