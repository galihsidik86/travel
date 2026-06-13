import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';
import {
  getAgentFunnel, getLeadSourceBreakdown, getDailyActivity,
  getPerPaketPerformance, getKomisiMonthly,
} from './analytics.js';

// Pipeline mapping: Booking.status → CRM kanban column
// COLD/WARM = pre-booking leads (no Lead model yet)
// HOT       = booking exists, money in motion (PENDING/BOOKED/DP_PAID/PARTIAL)
// LUNAS     = booking fully paid
const HOT_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL'];
const LUNAS_STATUSES = ['LUNAS'];

export async function getAgentDashboard(agentId, opts = {}) {
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    include: { user: { select: { fullName: true, email: true } } },
  });
  if (!agent) return null;

  const [
    bookings, komisiRows, activePaket, leads,
    funnel, sourceBreakdown, daily, payouts,
    perPaket, komisiMonthly,
  ] = await Promise.all([
    db.booking.findMany({
      where: { agentId },
      include: {
        paket: { select: { slug: true, title: true, departureDate: true } },
        jemaah: { select: { fullName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    db.komisi.findMany({ where: { agentId } }),
    db.paket.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { slug: true, title: true, subtitle: true, departureDate: true, kursiTotal: true, kursiTerisi: true },
      orderBy: { departureDate: 'asc' },
    }),
    // Stage 266 — kanban excludes snoozed leads (snoozedUntilAt > now).
    // No cron needed; the filter just naturally returns them when the
    // date elapses. Sort: overdue followUpAt first (asc nulls last —
    // Prisma's default puts nulls first, but we want unscheduled rows
    // at the bottom so overdue/due-today bubble up).
    db.lead.findMany({
      where: {
        agentId, deletedAt: null, status: { in: ['COLD', 'WARM'] },
        OR: [
          { snoozedUntilAt: null },
          { snoozedUntilAt: { lte: new Date() } },
        ],
      },
      orderBy: [{ followUpAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    }),
    getAgentFunnel(agentId, opts),
    getLeadSourceBreakdown(agentId, opts),
    getDailyActivity(agentId, opts),
    db.komisiPayout.findMany({
      where: { agentId },
      take: 20,
      orderBy: { paidAt: 'desc' },
      include: { _count: { select: { komisi: true } } },
    }),
    getPerPaketPerformance(agentId),
    getKomisiMonthly(agentId, { months: 6 }),
  ]);

  const pipeline = {
    cold: leads.filter((l) => l.status === 'COLD'),
    warm: leads.filter((l) => l.status === 'WARM'),
    hot: bookings.filter((b) => HOT_STATUSES.includes(b.status)),
    lunas: bookings.filter((b) => LUNAS_STATUSES.includes(b.status)),
  };

  const sumIdr = (arr, field) => arr.reduce((acc, x) => acc + (toNumber(x[field]) ?? 0), 0);
  const hotPotential = sumIdr(pipeline.hot, 'totalAmount');
  const lunasRevenue = sumIdr(pipeline.lunas, 'totalAmount');
  const leadPotential = sumIdr([...pipeline.cold, ...pipeline.warm], 'estValueIdr');

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const bookingsThisMonth = bookings.filter((b) => b.createdAt >= startOfMonth).length;
  const totalBookings = bookings.length;
  const conversionPct = totalBookings === 0
    ? null
    : Math.round((pipeline.lunas.length / totalBookings) * 100);

  const komisi = {
    pending: sumIdr(komisiRows.filter((k) => k.status === 'PENDING'), 'amount'),
    earned: sumIdr(komisiRows.filter((k) => k.status === 'EARNED'), 'amount'),
    paid: sumIdr(komisiRows.filter((k) => k.status === 'PAID'), 'amount'),
    cancelled: sumIdr(komisiRows.filter((k) => k.status === 'CANCELLED'), 'amount'),
  };
  komisi.wallet = komisi.earned; // belum dibayar tapi sudah locked
  komisi.total = komisi.pending + komisi.earned + komisi.paid + komisi.cancelled;

  const kpis = {
    bookingsThisMonth,
    totalBookings,
    conversionPct,
    leadCount: pipeline.cold.length + pipeline.warm.length,
    leadPotential,
    hotCount: pipeline.hot.length,
    hotPotential,
    lunasCount: pipeline.lunas.length,
    lunasRevenue,
    komisiEarned: komisi.earned,
    komisiWallet: komisi.wallet,
    komisiPending: komisi.pending,
  };

  return {
    agent,
    kpis,
    pipeline,
    komisi,
    payouts,
    marketingPaket: activePaket,
    analytics: { funnel, sourceBreakdown, daily, perPaket, komisiMonthly },
  };
}
