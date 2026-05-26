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
