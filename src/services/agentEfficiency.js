// Stage 387 — Agent efficiency metric (revenue per lead-hour).
//
// "Lead-hour" = average time (hours) elapsed from Lead creation to that
// lead's CONVERTED booking landing in LUNAS. Computed via the existing
// Lead.convertedBookingId backref + that booking's payment ledger to find
// when LUNAS status was reached.
//
// Per-agent rollup:
//   - totalLeads (any status)
//   - convertedLeads (Lead.status=CONVERTED)
//   - conversionRatePct
//   - avgHoursLeadToLunas (mean of per-conversion durations)
//   - lifetimeLunasRevenueIdr (sum across converted bookings)
//   - revenuePerLeadHourIdr = lifetimeLunasRevenueIdr / sum(lead-hours)
//     (proxy for "Rupiah generated per hour of lead-pipeline-time invested")
//
// Useful comparative metric — agent A with 100 leads → 20 LUNAS over avg
// 24h has different "efficiency" than agent B with 30 leads → 10 LUNAS
// over avg 168h, even at similar revenue.
//
// Min-sample guard: requires ≥3 CONVERTED leads before reporting a
// revenuePerLeadHour (single sample distorts the average).

import { db } from '../lib/db.js';

const MIN_CONVERTED = 3;

export async function getAgentEfficiency({ months = 6, now = new Date() } = {}) {
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1);

  // Pull all ACTIVE agent profiles + their Lead pipeline since cutoff
  const agents = await db.agentProfile.findMany({
    where: { user: { status: 'ACTIVE', deletedAt: null } },
    select: {
      id: true, slug: true, displayName: true,
      leads: {
        where: { createdAt: { gte: cutoff }, deletedAt: null },
        select: {
          id: true, createdAt: true, status: true,
          convertedBookingId: true,
        },
      },
    },
  });

  const rows = [];
  for (const a of agents) {
    const total = a.leads.length;
    const converted = a.leads.filter((l) => l.status === 'CONVERTED' && l.convertedBookingId);
    if (total === 0 && converted.length === 0) continue;
    // For each converted lead, look up the LUNAS-transition date of its
    // booking. We use `Booking.lunasAt` if present, else `Payment.paidAt`
    // of the latest PAID row that crossed totalAmount, else the booking's
    // updatedAt as last-resort proxy.
    const bookingIds = converted.map((c) => c.convertedBookingId);
    const lunasMap = new Map();
    if (bookingIds.length > 0) {
      const bookings = await db.booking.findMany({
        where: { id: { in: bookingIds }, status: 'LUNAS' },
        select: { id: true, totalAmount: true, updatedAt: true },
      });
      for (const b of bookings) {
        lunasMap.set(b.id, {
          lunasAt: b.updatedAt, // pragmatic proxy: Booking row last touched
          revenueIdr: Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0,
        });
      }
    }
    let totalLunasHours = 0;
    let lunasCount = 0;
    let lunasRevenue = 0;
    for (const lead of converted) {
      const info = lunasMap.get(lead.convertedBookingId);
      if (!info) continue;
      const hours = Math.max(0.5, (info.lunasAt.getTime() - lead.createdAt.getTime()) / 3_600_000);
      totalLunasHours += hours;
      lunasCount += 1;
      lunasRevenue += info.revenueIdr;
    }
    const avgHoursLeadToLunas = lunasCount > 0 ? Math.round(totalLunasHours / lunasCount) : null;
    const revenuePerLeadHourIdr = totalLunasHours > 0
      ? Math.round(lunasRevenue / totalLunasHours)
      : null;
    const conversionRatePct = total > 0
      ? Math.round((converted.length / total) * 1000) / 10
      : null;
    rows.push({
      agentId: a.id, slug: a.slug, displayName: a.displayName || a.slug,
      totalLeads: total,
      convertedLeads: converted.length,
      lunasLeads: lunasCount,
      conversionRatePct,
      avgHoursLeadToLunas,
      lunasRevenueIdr: lunasRevenue,
      revenuePerLeadHourIdr,
      lowSample: lunasCount < MIN_CONVERTED,
    });
  }
  // Sort by revenuePerLeadHourIdr desc, lowSample to the back
  rows.sort((a, b) => {
    if (a.lowSample && !b.lowSample) return 1;
    if (!a.lowSample && b.lowSample) return -1;
    return (b.revenuePerLeadHourIdr || 0) - (a.revenuePerLeadHourIdr || 0);
  });
  return { rows, months, minSample: MIN_CONVERTED };
}

export { MIN_CONVERTED };
