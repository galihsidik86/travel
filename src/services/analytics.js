import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const HOT_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL'];
const LEAD_SOURCES = ['WA', 'IG', 'FB', 'TIKTOK', 'WALK_IN', 'REFERRAL', 'AD', 'OTHER'];

/**
 * Resolve a date range from {from, to} strings (YYYY-MM-DD).
 * Defaults to the last 30 days when either side is missing.
 * Returns { from: Date, to: Date, days: number } — both Date objects
 * with time normalized to start-of-day and end-of-day respectively.
 */
export function resolveRange({ from, to } = {}) {
  // Parse safely — invalid strings fall back to the default range.
  const parse = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const now = new Date();
  let toDate = parse(to) ?? new Date(now);
  let fromDate = parse(from);

  if (!fromDate) {
    fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 29); // 30-day window
  }

  // Normalize after potential swap so each end sits at day-boundary.
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  fromDate.setHours(0, 0, 0, 0);
  toDate.setHours(23, 59, 59, 999);

  const days = Math.max(1, Math.floor((toDate - fromDate) / 86_400_000) + 1);
  return { from: fromDate, to: toDate, days };
}

function withDateRange(where, range) {
  if (range) where.createdAt = { gte: range.from, lte: range.to };
  return where;
}

/**
 * Conversion funnel — counts within a date range (default last 30 days).
 * "Within range" means the entity was *created* in that period.
 */
export async function getAgentFunnel(agentId, opts = {}) {
  const range = resolveRange(opts);

  const whereLead = withDateRange({ deletedAt: null, ...(agentId ? { agentId } : {}) }, range);
  const whereBooking = withDateRange(agentId ? { agentId } : {}, range);

  const [leadsByStatus, bookingsByStatus] = await Promise.all([
    db.lead.groupBy({ by: ['status'], where: whereLead, _count: { _all: true } }),
    db.booking.groupBy({ by: ['status'], where: whereBooking, _count: { _all: true } }),
  ]);

  const lead = { COLD: 0, WARM: 0, CONVERTED: 0, LOST: 0 };
  for (const row of leadsByStatus) lead[row.status] = row._count._all;
  const leadsTotal = lead.COLD + lead.WARM + lead.CONVERTED + lead.LOST;

  const book = {};
  for (const row of bookingsByStatus) book[row.status] = row._count._all;
  const bookingsHot = HOT_STATUSES.reduce((acc, s) => acc + (book[s] || 0), 0);
  const bookingsLunas = book.LUNAS || 0;
  const bookingsTotal = Object.values(book).reduce((a, b) => a + b, 0);

  const pct = (num, denom) => (denom === 0 ? null : Math.round((num / denom) * 100));

  return {
    range,
    lead,
    leadsTotal,
    bookingsHot,
    bookingsLunas,
    bookingsTotal,
    convertedFromLeadPct: pct(lead.CONVERTED, leadsTotal),
    leadLossPct: pct(lead.LOST, leadsTotal),
    lunasFromBookingPct: pct(bookingsLunas, bookingsTotal),
  };
}

/**
 * Lead source breakdown — within a date range.
 */
export async function getLeadSourceBreakdown(agentId, opts = {}) {
  const range = resolveRange(opts);
  const where = withDateRange({ deletedAt: null, ...(agentId ? { agentId } : {}) }, range);
  const rows = await db.lead.groupBy({
    by: ['source', 'status'],
    where,
    _count: { _all: true },
  });
  const byKey = new Map();
  for (const s of LEAD_SOURCES) byKey.set(s, { source: s, total: 0, converted: 0, lost: 0, active: 0 });
  for (const row of rows) {
    const entry = byKey.get(row.source) || { source: row.source, total: 0, converted: 0, lost: 0, active: 0 };
    entry.total += row._count._all;
    if (row.status === 'CONVERTED') entry.converted += row._count._all;
    else if (row.status === 'LOST') entry.lost += row._count._all;
    else entry.active += row._count._all;
    byKey.set(row.source, entry);
  }
  return [...byKey.values()]
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, conversionPct: r.total === 0 ? null : Math.round((r.converted / r.total) * 100) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Daily activity buckets within a date range. Caps at 366 days to keep
 * the SVG sparkline readable.
 */
export async function getDailyActivity(agentId, opts = {}) {
  let range = resolveRange(opts);
  if (range.days > 366) {
    // Trim to last 366 days from the requested `to`
    const trimmedFrom = new Date(range.to);
    trimmedFrom.setDate(trimmedFrom.getDate() - 365);
    trimmedFrom.setHours(0, 0, 0, 0);
    range = { from: trimmedFrom, to: range.to, days: 366 };
  }

  const whereLead = { deletedAt: null, createdAt: { gte: range.from, lte: range.to }, ...(agentId ? { agentId } : {}) };
  const whereBooking = { createdAt: { gte: range.from, lte: range.to }, ...(agentId ? { agentId } : {}) };

  const [leads, bookings] = await Promise.all([
    db.lead.findMany({ where: whereLead, select: { createdAt: true } }),
    db.booking.findMany({
      where: whereBooking,
      select: { createdAt: true, totalAmount: true, status: true },
    }),
  ]);

  const buckets = new Map();
  for (let i = 0; i < range.days; i++) {
    const d = new Date(range.from);
    d.setDate(range.from.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, leadsCreated: 0, bookingsCreated: 0, revenue: 0 });
  }
  const bucketOf = (d) => d.toISOString().slice(0, 10);

  for (const l of leads) {
    const k = bucketOf(l.createdAt);
    const row = buckets.get(k);
    if (row) row.leadsCreated += 1;
  }
  for (const b of bookings) {
    const k = bucketOf(b.createdAt);
    const row = buckets.get(k);
    if (!row) continue;
    row.bookingsCreated += 1;
    if (b.status === 'LUNAS') row.revenue += toNumber(b.totalAmount) ?? 0;
  }
  return [...buckets.values()];
}

/**
 * Per-paket performance for a single agent. For each paket the agent has
 * touched (any booking — including CANCELLED/REFUNDED so historical work
 * isn't hidden), returns counts + revenue + conversionPct (lunas / total).
 *
 * Sorted by lunasRevenue desc — the best earner bubbles up. Limit caps the
 * result size for the leaderboard panel; pass 0 for unbounded.
 */
export async function getPerPaketPerformance(agentId, { limit = 8 } = {}) {
  if (!agentId) return [];
  const bookings = await db.booking.findMany({
    where: { agentId },
    select: {
      status: true, totalAmount: true,
      paketId: true,
      paket: { select: { slug: true, title: true, departureDate: true, status: true } },
    },
  });
  if (bookings.length === 0) return [];

  const byPaket = new Map();
  for (const b of bookings) {
    if (!b.paket) continue; // defensive — orphan booking
    const key = b.paketId;
    let row = byPaket.get(key);
    if (!row) {
      row = {
        paketId: key,
        slug: b.paket.slug,
        title: b.paket.title,
        departureDate: b.paket.departureDate,
        paketStatus: b.paket.status,
        totalBookings: 0,
        hotCount: 0,
        lunasCount: 0,
        cancelledCount: 0,
        lunasRevenue: 0,
      };
      byPaket.set(key, row);
    }
    row.totalBookings += 1;
    if (HOT_STATUSES.includes(b.status)) row.hotCount += 1;
    else if (b.status === 'LUNAS') {
      row.lunasCount += 1;
      row.lunasRevenue += toNumber(b.totalAmount) ?? 0;
    }
    else if (b.status === 'CANCELLED' || b.status === 'REFUNDED') row.cancelledCount += 1;
  }

  const out = [...byPaket.values()].map((r) => ({
    ...r,
    conversionPct: r.totalBookings === 0
      ? null
      : Math.round((r.lunasCount / r.totalBookings) * 100),
  }));
  out.sort((a, b) => b.lunasRevenue - a.lunasRevenue
    || b.lunasCount - a.lunasCount
    || a.title.localeCompare(b.title));
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Cross-agent per-paket leaderboard (admin variant of getPerPaketPerformance).
 *
 * Optionally narrowed to a date range (booking.createdAt). Defaults to all-
 * time so the admin overview shows lifetime performance regardless of the
 * funnel date filter — agents come and go, paket revenue is forever.
 *
 * Adds `agentCount` (distinct agents who have booked this paket) and
 * `directCount` (bookings with no agent = Kantor Pusat) since admin cares
 * about distribution that the agent dashboard hides.
 */
export async function getPerPaketLeaderboard({ from, to, limit = 8 } = {}) {
  const where = {};
  if (from || to) {
    const range = resolveRange({ from, to });
    where.createdAt = { gte: range.from, lte: range.to };
  }
  where.paket = { deletedAt: null, status: { not: 'ARCHIVED' } };

  const bookings = await db.booking.findMany({
    where,
    select: {
      status: true, totalAmount: true,
      paketId: true, agentId: true,
      paket: { select: { slug: true, title: true, departureDate: true, status: true } },
    },
  });
  if (bookings.length === 0) return [];

  const byPaket = new Map();
  for (const b of bookings) {
    if (!b.paket) continue;
    const key = b.paketId;
    let row = byPaket.get(key);
    if (!row) {
      row = {
        paketId: key,
        slug: b.paket.slug, title: b.paket.title,
        departureDate: b.paket.departureDate,
        paketStatus: b.paket.status,
        totalBookings: 0,
        hotCount: 0,
        lunasCount: 0,
        cancelledCount: 0,
        lunasRevenue: 0,
        directCount: 0,
        agentIds: new Set(),
      };
      byPaket.set(key, row);
    }
    row.totalBookings += 1;
    if (HOT_STATUSES.includes(b.status)) row.hotCount += 1;
    else if (b.status === 'LUNAS') {
      row.lunasCount += 1;
      row.lunasRevenue += toNumber(b.totalAmount) ?? 0;
    }
    else if (b.status === 'CANCELLED' || b.status === 'REFUNDED') row.cancelledCount += 1;
    if (b.agentId) row.agentIds.add(b.agentId);
    else row.directCount += 1;
  }

  const out = [...byPaket.values()].map((r) => ({
    ...r,
    agentCount: r.agentIds.size,
    agentIds: undefined,                // strip Set from response
    conversionPct: r.totalBookings === 0
      ? null
      : Math.round((r.lunasCount / r.totalBookings) * 100),
  }));
  out.sort((a, b) => b.lunasRevenue - a.lunasRevenue
    || b.lunasCount - a.lunasCount
    || a.title.localeCompare(b.title));
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Komisi income arc: per-month totals for the last N months (default 6),
 * inclusive of the current month. Buckets are UTC-aligned to YYYY-MM keys.
 *
 * Returns one row per month in chronological order:
 *   { month: 'YYYY-MM', label: 'Mei 26', earned, paid, pending }
 *
 * Earned = komisi.earnedAt landed in this month.
 * Paid   = komisi.paidAt landed (regardless of when earned).
 * Pending = komisi.createdAt landed (regardless of status).
 * Cancelled is excluded — those rows reflect undone work, not income.
 */
const MONTH_LABEL_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

export async function getKomisiMonthly(agentId, { months = 6, now = new Date() } = {}) {
  if (!agentId) return [];
  return komisiMonthlyImpl({ agentId, months, now });
}

/**
 * Admin variant — same shape as getKomisiMonthly but aggregated across ALL
 * agents (no agentId filter). Used on /admin overview to surface the global
 * komisi income arc alongside per-agent breakdowns.
 */
export async function getKomisiMonthlyAdmin({ months = 6, now = new Date() } = {}) {
  return komisiMonthlyImpl({ agentId: null, months, now });
}

async function komisiMonthlyImpl({ agentId, months, now }) {
  // Range: first day of (months-1) months ago → end of current month.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)); // exclusive

  const rows = await db.komisi.findMany({
    where: {
      ...(agentId ? { agentId } : {}),    // omit filter for the admin variant
      status: { not: 'CANCELLED' },
      OR: [
        { createdAt: { gte: start, lt: end } },
        { earnedAt:  { gte: start, lt: end } },
        { paidAt:    { gte: start, lt: end } },
      ],
    },
    select: { status: true, amount: true, createdAt: true, earnedAt: true, paidAt: true },
  });

  // Build empty buckets so months with zero activity still render.
  const buckets = new Map();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, {
      month: key,
      label: `${MONTH_LABEL_ID[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`,
      earned: 0, paid: 0, pending: 0,
    });
  }
  const keyOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const inRange = (d) => d && d >= start && d < end;

  for (const k of rows) {
    const amt = toNumber(k.amount) ?? 0;
    if (k.earnedAt && inRange(k.earnedAt)) {
      buckets.get(keyOf(k.earnedAt))?.earned !== undefined
        && (buckets.get(keyOf(k.earnedAt)).earned += amt);
    }
    if (k.paidAt && inRange(k.paidAt)) {
      buckets.get(keyOf(k.paidAt))?.paid !== undefined
        && (buckets.get(keyOf(k.paidAt)).paid += amt);
    }
    if (k.status === 'PENDING' && k.createdAt && inRange(k.createdAt)) {
      buckets.get(keyOf(k.createdAt))?.pending !== undefined
        && (buckets.get(keyOf(k.createdAt)).pending += amt);
    }
  }
  return [...buckets.values()];
}
