import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';
import {
  getLeadSourceBreakdown, getAgentFunnel, resolveRange,
  getPerPaketLeaderboard, getKomisiMonthlyAdmin,
} from './analytics.js';
import { buildDigestWithComparison } from './dailyDigest.js';
import { getNeedsAttention } from './needsAttention.js';
import { getRefundAnalytics } from './refundAnalytics.js';
import { getPaketForecasts } from './paketForecast.js';
import { getKomisiAging } from './komisiAging.js';
import { getManifestClosing } from './manifestClose.js';
import { pillsForJemaah } from './jemaahDocs.js';

const HOT_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL'];

/**
 * Aggregate overview for the admin landing.
 * Read-only — no writes happen here.
 */
export async function getAdminOverview(opts = {}) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);

  const [
    bookings,
    leadCount24h,
    paketAll,
    agents,
    jemaahCount,
    recentAudit,
    komisiAgg,
    globalFunnel,
    globalSourceBreakdown,
    leadCountByAgent,
  ] = await Promise.all([
    db.booking.findMany({
      include: {
        paket: { select: { slug: true, title: true } },
        jemaah: { select: { fullName: true } },
        agent: { select: { slug: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.lead.count({ where: { deletedAt: null, createdAt: { gte: dayAgo } } }),
    // Admin tab needs DRAFT/CLOSED too — only ARCHIVED stays hidden.
    db.paket.findMany({
      where: { deletedAt: null, status: { not: 'ARCHIVED' } },
      select: {
        id: true, slug: true, title: true, subtitle: true,
        departureDate: true, durationDays: true,
        kursiTotal: true, kursiTerisi: true, status: true,
        komisiRate: true,
        prices: { select: { kelas: true, priceIdr: true, isFeatured: true } },
      },
      orderBy: [{ status: 'asc' }, { departureDate: 'asc' }],
    }),
    db.agentProfile.findMany({
      select: {
        id: true, slug: true, displayName: true, tier: true,
        user: { select: { fullName: true } },
        bookings: { select: { id: true, status: true, totalAmount: true } },
        komisi: { select: { amount: true, status: true } },
      },
    }),
    db.jemaahProfile.count(),
    db.auditLog.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, action: true, entity: true, entityId: true,
        actorEmail: true, actorRole: true, createdAt: true, after: true, before: true,
      },
    }),
    db.komisi.groupBy({
      by: ['status'],
      _sum: { amount: true },
    }),
    getAgentFunnel(null, opts),
    getLeadSourceBreakdown(null, opts),
    db.lead.groupBy({
      by: ['agentId', 'status'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  // KPIs
  const sumDec = (arr, field) => arr.reduce((acc, x) => acc + (toNumber(x[field]) ?? 0), 0);
  const lunasBookings = bookings.filter((b) => b.status === 'LUNAS');
  const hotBookings = bookings.filter((b) => HOT_STATUSES.includes(b.status));
  const revenueLunas = sumDec(lunasBookings, 'totalAmount');
  const paidAll = sumDec(bookings, 'paidAmount');
  const potentialHot = sumDec(hotBookings, 'totalAmount') - sumDec(hotBookings, 'paidAmount');

  const quarterBookings = bookings.filter((b) => b.createdAt >= startOfQuarter);
  const monthBookings = bookings.filter((b) => b.createdAt >= startOfMonth);
  const todayBookings = bookings.filter((b) => b.createdAt >= startOfDay);

  const statusBreakdown = bookings.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {});

  // Top paket (active only, sorted by fill rate desc, ties broken by departure date)
  const paketActive = paketAll.filter((p) => p.status === 'ACTIVE');
  const topPaket = paketActive
    .map((p) => ({
      ...p,
      fillPct: p.kursiTotal === 0 ? 0 : Math.round((p.kursiTerisi / p.kursiTotal) * 100),
    }))
    .sort((a, b) => b.fillPct - a.fillPct || a.departureDate - b.departureDate);

  // paketList includes DRAFT/ACTIVE/CLOSED for admin tab + manifest/bunking
  // dropdown. Sort: ACTIVE first, then CLOSED, then DRAFT, then by departure.
  const STATUS_RANK = { ACTIVE: 0, CLOSED: 1, DRAFT: 2 };
  const paketList = paketAll
    .map((p) => ({
      ...p,
      fillPct: p.kursiTotal === 0 ? 0 : Math.round((p.kursiTerisi / p.kursiTotal) * 100),
    }))
    .sort((a, b) =>
      (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
      || (a.departureDate?.getTime() ?? 0) - (b.departureDate?.getTime() ?? 0)
    );

  // Per-agent lead counts (from groupBy)
  const leadCounts = new Map();
  for (const row of leadCountByAgent) {
    const entry = leadCounts.get(row.agentId) || { COLD: 0, WARM: 0, CONVERTED: 0, LOST: 0 };
    entry[row.status] = (entry[row.status] || 0) + row._count._all;
    leadCounts.set(row.agentId, entry);
  }

  // Stage 45 — per-agent 30-day booking sparkline. Built from the existing
  // `bookings` array (no extra query) by bucketing per agent × local day.
  // The agents .bookings shape only includes id/status/totalAmount — we
  // need createdAt, which is on the top-level `bookings` array used for
  // KPIs. Pre-compute a per-agent daily-count map once.
  const SPARKLINE_DAYS = 30;
  const sparkStart = new Date(startOfDay.getTime() - (SPARKLINE_DAYS - 1) * 86_400_000);
  const sparkBuckets = new Map(); // agentId → number[30]
  for (const b of bookings) {
    if (!b.agentId) continue;
    if (b.createdAt < sparkStart) continue;
    const dayIdx = Math.floor((b.createdAt.getTime() - sparkStart.getTime()) / 86_400_000);
    if (dayIdx < 0 || dayIdx >= SPARKLINE_DAYS) continue;
    let arr = sparkBuckets.get(b.agentId);
    if (!arr) {
      arr = new Array(SPARKLINE_DAYS).fill(0);
      sparkBuckets.set(b.agentId, arr);
    }
    arr[dayIdx] += 1;
  }

  // Top agents (sorted by lunas revenue desc)
  const topAgents = agents
    .map((a) => {
      const lunas = a.bookings.filter((b) => b.status === 'LUNAS');
      const active = a.bookings.filter((b) => HOT_STATUSES.includes(b.status));
      const lc = leadCounts.get(a.id) || { COLD: 0, WARM: 0, CONVERTED: 0, LOST: 0 };
      const leadTotal = lc.COLD + lc.WARM + lc.CONVERTED + lc.LOST;
      return {
        slug: a.slug,
        displayName: a.displayName,
        tier: a.tier,
        bookingCount: a.bookings.length,
        lunasCount: lunas.length,
        activeCount: active.length,
        revenue: sumDec(lunas, 'totalAmount'),
        komisiEarned: sumDec(a.komisi.filter((k) => k.status === 'EARNED'), 'amount'),
        komisiPaid: sumDec(a.komisi.filter((k) => k.status === 'PAID'), 'amount'),
        leadTotal,
        leadConverted: lc.CONVERTED,
        leadConvPct: leadTotal === 0 ? null : Math.round((lc.CONVERTED / leadTotal) * 100),
        // Stage 45 — 30 daily booking counts oldest→newest; null when the
        // agent has zero recent activity so the view can render a dash.
        sparkline: sparkBuckets.get(a.id) ?? null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Komisi roll-up (all agents)
  const komisiTotals = { PENDING: 0, EARNED: 0, PAID: 0, CANCELLED: 0 };
  for (const row of komisiAgg) {
    komisiTotals[row.status] = toNumber(row._sum.amount) ?? 0;
  }

  const kpis = {
    revenueLunas,
    paidAll,
    potentialHot,
    bookingCount: bookings.length,
    bookingThisMonth: monthBookings.length,
    bookingToday: todayBookings.length,
    bookingThisQuarter: quarterBookings.length,
    leadCount24h,
    paketActiveCount: paketActive.length,
    jemaahCount,
    agentCount: agents.length,
    komisi: komisiTotals,
  };

  // Per-paket revenue trend (5ee) — honor date range filter (defaults to 30d).
  // Single-query approach to avoid N+1: pull all LUNAS bookings in range, then
  // bucket by (paketId, day) in-memory.
  const range = resolveRange(opts);
  const lunasInRange = await db.booking.findMany({
    where: {
      status: 'LUNAS',
      createdAt: { gte: range.from, lte: range.to },
      paket: { deletedAt: null, status: { not: 'ARCHIVED' } },
    },
    select: { paketId: true, createdAt: true, totalAmount: true, paket: { select: { slug: true, title: true } } },
  });
  const dayBuckets = new Map(); // paketId → Map(dayKey → revenue)
  const paketMeta = new Map();   // paketId → {slug, title}
  for (const b of lunasInRange) {
    const dayKey = b.createdAt.toISOString().slice(0, 10);
    if (!dayBuckets.has(b.paketId)) {
      dayBuckets.set(b.paketId, new Map());
      paketMeta.set(b.paketId, { slug: b.paket.slug, title: b.paket.title });
    }
    const map = dayBuckets.get(b.paketId);
    map.set(dayKey, (map.get(dayKey) || 0) + (toNumber(b.totalAmount) ?? 0));
  }
  // Fill missing days with 0 so sparklines have consistent X-axis
  const allDays = [];
  for (let i = 0; i < range.days; i++) {
    const d = new Date(range.from);
    d.setDate(range.from.getDate() + i);
    allDays.push(d.toISOString().slice(0, 10));
  }
  const paketRevenueTrend = [...dayBuckets.entries()].map(([paketId, map]) => {
    const daily = allDays.map((dk) => ({ date: dk, revenue: map.get(dk) || 0 }));
    const total = daily.reduce((acc, x) => acc + x.revenue, 0);
    return { paketId, ...paketMeta.get(paketId), daily, total };
  }).sort((a, b) => b.total - a.total);

  // Stage 16 admin parity: per-paket leaderboard (date-range scoped, mirrors
  // funnel) + cross-agent komisi monthly arc (always last 6 months — month-
  // granularity doesn't combine usefully with the day-granularity range
  // filter the funnel uses).
  const [perPaketLeaderboard, komisiMonthly] = await Promise.all([
    getPerPaketLeaderboard({ from: opts.from, to: opts.to, limit: 8 }),
    getKomisiMonthlyAdmin({ months: 6 }),
  ]);

  // Stage 25 — turn raw audit rows into friendly activity-feed entries
  // (sentence + deep-link + badge + optional amountIdr).
  const { formatRecentActivity } = await import('../lib/auditFormat.js');
  const recentActivity = formatRecentActivity(recentAudit);

  // Stage 28 — yesterday-at-a-glance panel: same source as the 07:00 email
  // digest, so UI and inbox never drift apart. Stage 29 upgrades the call
  // to the comparison helper so each cell can render a day-over-day delta.
  // Failures are non-fatal — owner can still see KPIs/recent activity if
  // the digest aggregator throws.
  let yesterday = null;
  try {
    yesterday = await buildDigestWithComparison();
  } catch (err) {
    console.warn('[admin-overview] buildDigestWithComparison failed:', err?.message || err);
  }

  // Stage 31 — needs-attention rolls up stuck rows (terminal FAILED notifs,
  // cancel-requests >24h pending, OPEN incidents >24h old). Same failure
  // posture as the digest — non-fatal, view conditionally hides.
  let needsAttention = null;
  try {
    needsAttention = await getNeedsAttention();
  } catch (err) {
    console.warn('[admin-overview] getNeedsAttention failed:', err?.message || err);
  }

  // Stage 35 — refund analytics (last 90d, top 10 per dimension).
  let refundAnalytics = null;
  try {
    refundAnalytics = await getRefundAnalytics();
  } catch (err) {
    console.warn('[admin-overview] getRefundAnalytics failed:', err?.message || err);
  }

  // Stage 40 — per-paket forecast (14d velocity → days-to-full).
  let paketForecasts = null;
  try {
    paketForecasts = await getPaketForecasts();
  } catch (err) {
    console.warn('[admin-overview] getPaketForecasts failed:', err?.message || err);
  }

  // Stage 41 — komisi liability aging (per agent × 4 age buckets).
  let komisiAging = null;
  try {
    komisiAging = await getKomisiAging();
  } catch (err) {
    console.warn('[admin-overview] getKomisiAging failed:', err?.message || err);
  }

  // Stage 43 — manifest closing countdown (urgent within 72h or overdue).
  let manifestClosing = null;
  try {
    manifestClosing = await getManifestClosing();
  } catch (err) {
    console.warn('[admin-overview] getManifestClosing failed:', err?.message || err);
  }

  return {
    kpis,
    recentActivity,
    topPaket,
    topAgents,
    statusBreakdown,
    paketList,
    yesterday,
    needsAttention,
    refundAnalytics,
    paketForecasts,
    komisiAging,
    manifestClosing,
    analytics: {
      funnel: globalFunnel,
      sourceBreakdown: globalSourceBreakdown,
      perPaketLeaderboard,
      komisiMonthly,
    },
    paketRevenueTrend,
    revenueTrendRange: range,
  };
}

/**
 * Cash & receivables snapshot for the Finance tab.
 *   - cashByCurrency: sum of PAID payment.amount per currency
 *   - receivables: sum of (totalAmount - paidAmount) for non-cancelled bookings
 *   - paymentLedger: 20 most recent payments with booking + jemaah info
 */
export async function getFinanceSummary() {
  const [paymentSums, openBookings, ledger] = await Promise.all([
    db.payment.groupBy({
      by: ['currency'],
      where: { status: { in: ['PAID', 'REFUNDED'] } }, // net: refunds (negative) reduce cash
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.booking.findMany({
      where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      select: { totalAmount: true, paidAmount: true, status: true },
    }),
    db.payment.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        booking: {
          select: {
            bookingNo: true,
            jemaah: { select: { fullName: true } },
            paket: { select: { title: true } },
          },
        },
      },
    }),
  ]);

  const cashByCurrency = paymentSums.map((row) => ({
    currency: row.currency,
    amount: toNumber(row._sum.amount) ?? 0,
    count: row._count._all,
  }));

  const receivables = openBookings.reduce((acc, b) => {
    const t = toNumber(b.totalAmount) ?? 0;
    const p = toNumber(b.paidAmount) ?? 0;
    return acc + Math.max(0, t - p);
  }, 0);

  const receivedTotal = openBookings.reduce(
    (acc, b) => acc + (toNumber(b.paidAmount) ?? 0),
    0,
  );

  return {
    cashByCurrency,
    receivables,
    receivedTotal,
    paymentLedger: ledger,
  };
}

/**
 * Build a CSV string for one paket's manifest (5gg).
 *   - UTF-8 BOM so Excel opens with correct encoding
 *   - Comma delimiter; fields wrapped in double-quotes when they contain `,`/`"`/newline
 *   - One row per booking + a header row
 *   - Returns { filename, csv } so the route can set Content-Disposition cleanly
 *
 * Returns null if the paket doesn't exist.
 */
export async function exportManifestCsv(paketSlug) {
  const data = await getManifestForPaket(paketSlug);
  if (!data) return null;
  const { paket, bookings } = data;

  const headers = [
    'Booking No', 'Status', 'Kelas', 'PAX',
    'Nama Jemaah', 'Telepon', 'Email', 'NIK', 'Paspor', 'Paspor Expire',
    'Total (IDR)', 'Dibayar (IDR)', 'Sisa (IDR)',
    'Agen', 'Agen Slug',
    'Booking Fee At', 'Cancelled At', 'Cancel Reason',
    'Doc Verified', 'Doc Total',
  ];

  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = bookings.map((b) => {
    const total = toNumber(b.totalAmount) ?? 0;
    const paid = toNumber(b.paidAmount) ?? 0;
    const docs = b.jemaah?.documents || [];
    const verified = docs.filter((d) => d.status === 'VERIFIED').length;
    return [
      b.bookingNo,
      b.status,
      b.kelas,
      b.paxCount,
      b.jemaah?.fullName,
      b.jemaah?.phone,
      b.jemaah?.email,
      b.jemaah?.nik,
      b.jemaah?.passportNo,
      b.jemaah?.passportExpiry ? b.jemaah.passportExpiry.toISOString().slice(0, 10) : '',
      total,
      paid,
      Math.max(0, total - paid),
      b.agent?.displayName ?? '— Kantor Pusat —',
      b.agent?.slug ?? '',
      b.bookingFeeAt ? b.bookingFeeAt.toISOString().slice(0, 10) : '',
      b.cancelledAt ? b.cancelledAt.toISOString().slice(0, 10) : '',
      b.cancelReason ?? '',
      verified,
      docs.length,
    ].map(escape).join(',');
  });

  // \uFEFF BOM forces Excel to detect UTF-8 (Indonesian text + special chars render correctly)
  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const safeSlug = paket.slug.replace(/[^a-z0-9_-]/gi, '_');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `manifest_${safeSlug}_${today}.csv`;
  return { filename, csv, count: bookings.length };
}

/**
 * Manifest for a single paket: every Booking (and associated jemaah)
 * belonging to that paket, sorted by created date desc.
 */
export async function getManifestForPaket(paketSlug) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: {
      id: true, slug: true, title: true, subtitle: true,
      departureDate: true, kursiTotal: true, kursiTerisi: true,
      status: true,
    },
  });
  if (!paket) return null;

  const bookings = await db.booking.findMany({
    where: { paketId: paket.id },
    include: {
      jemaah: {
        select: {
          fullName: true, phone: true, email: true, nik: true,
          passportNo: true, passportExpiry: true, gender: true, birthDate: true,
          documents: { select: { type: true, status: true } },
        },
      },
      agent: { select: { slug: true, displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const statusCounts = bookings.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {});

  // Attach doc pills to each jemaah for the manifest table
  for (const b of bookings) {
    b.jemaah.docPills = pillsForJemaah(b.jemaah.documents || []);
  }

  return { paket, bookings, statusCounts };
}

/**
 * Print-friendly manifest (stage 19) — airport check-in worksheet.
 * Filters out CANCELLED + REFUNDED bookings ("who's actually going"),
 * includes room assignment + emergency contact + curated doc pills.
 * Sorted by room (so jemaah sharing a kamar land adjacent on paper),
 * then by jemaah name for unassigned.
 */
export async function getPrintManifest(paketSlug) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug, deletedAt: null },
    select: {
      id: true, slug: true, title: true, subtitle: true,
      departureDate: true, returnDate: true, durationDays: true,
      airline: true, airlineCode: true, routeFrom: true, routeTo: true,
      kursiTotal: true, kursiTerisi: true,
    },
  });
  if (!paket) return null;

  const bookings = await db.booking.findMany({
    where: {
      paketId: paket.id,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true, status: true,
      notes: true,
      jemaah: {
        select: {
          fullName: true, phone: true, email: true,
          nik: true, gender: true, birthDate: true,
          passportNo: true, passportExpiry: true,
          emergencyContact: true,
          documents: { select: { type: true, status: true } },
        },
      },
      room: { select: { roomNo: true, floor: true, wing: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });

  for (const b of bookings) {
    b.jemaah.docPills = pillsForJemaah(b.jemaah.documents || []);
  }

  // Sort: assigned rooms first (grouped together by roomNo), unassigned by
  // name at the end. Within the same room, sort by jemaah name so couples /
  // family members appear adjacent in a predictable order.
  bookings.sort((a, b) => {
    const aRoom = a.room?.roomNo ?? null;
    const bRoom = b.room?.roomNo ?? null;
    if (aRoom && !bRoom) return -1;
    if (!aRoom && bRoom) return 1;
    if (aRoom && bRoom && aRoom !== bRoom) return aRoom.localeCompare(bRoom);
    return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
  });

  const activeCount = bookings.length;
  const paxCount = bookings.reduce((acc, b) => acc + (b.paxCount || 1), 0);
  const unassignedRoomCount = bookings.filter((b) => !b.room).length;

  return {
    paket, bookings,
    counts: { activeCount, paxCount, unassignedRoomCount },
    generatedAt: new Date(),
  };
}
