// Stage 386 — Break-even season comparison.
//
// For each paket with cost data + at least one LUNAS booking, computes
// "days to break-even" — number of days from FIRST LUNAS booking to the
// LUNAS booking whose cumulative revenue crosses paket's totalCost
// (costPerPaxIdr × kursiTotal as the conservative budget).
//
// Compares against the previous season via `Paket.clonedFromId` chain
// (S18 paket clone + S34 YoY leaderboard already populate this).
// Returns rows with delta vs previous season — positive = faster, negative
// = slower. Helps owner answer "did Ramadhan 2027 fill faster than 2026?".
//
// Sample-size guard: paket needs ≥3 LUNAS bookings before we even compute
// daysToBreakEven (single booking → trivially "broke even on day 1" is
// misleading). Returns brokeEven=false when cumulative LUNAS revenue
// hasn't yet covered totalCost.

import { db } from '../lib/db.js';

const MIN_LUNAS = 3;

async function getPaketBreakEvenStat(paket) {
  if (!paket.costPerPaxIdr || !paket.kursiTotal) {
    return { paketId: paket.id, hasCost: false };
  }
  const costPerPax = Number(paket.costPerPaxIdr?.toString?.() ?? paket.costPerPaxIdr);
  const totalCost = costPerPax * paket.kursiTotal;
  // Pull all LUNAS bookings (statusChangedAt would be more accurate but
  // not consistently tracked across older bookings — use createdAt as
  // proxy for "when revenue locked in").
  const lunasBookings = await db.booking.findMany({
    where: { paketId: paket.id, status: 'LUNAS' },
    select: { totalAmount: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (lunasBookings.length < MIN_LUNAS) {
    return {
      paketId: paket.id, hasCost: true,
      lunasCount: lunasBookings.length,
      totalCostIdr: totalCost,
      brokeEven: false,
      lowSample: true,
    };
  }
  const firstLunasAt = lunasBookings[0].createdAt;
  let cumulative = 0;
  let breakEvenAt = null;
  for (const b of lunasBookings) {
    cumulative += Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
    if (!breakEvenAt && cumulative >= totalCost) breakEvenAt = b.createdAt;
  }
  const brokeEven = !!breakEvenAt;
  const daysToBreakEven = brokeEven
    ? Math.max(1, Math.ceil((breakEvenAt.getTime() - firstLunasAt.getTime()) / 86_400_000))
    : null;
  return {
    paketId: paket.id, hasCost: true,
    lunasCount: lunasBookings.length,
    totalCostIdr: totalCost,
    totalRevenueIdr: cumulative,
    brokeEven, daysToBreakEven,
    firstLunasAt, breakEvenAt,
  };
}

export async function getBreakEvenSeasonComparison({ limit = 20 } = {}) {
  // Walk paket with clonedFromId (i.e. they have a previous season)
  // and computed cost. Filter to those with at least MIN_LUNAS bookings.
  const paket = await db.paket.findMany({
    where: {
      deletedAt: null,
      clonedFromId: { not: null },
      costPerPaxIdr: { not: null },
    },
    select: {
      id: true, slug: true, title: true,
      departureDate: true, kursiTotal: true,
      costPerPaxIdr: true,
      clonedFromId: true,
    },
    orderBy: { departureDate: 'desc' },
    take: limit,
  });

  const rows = [];
  for (const p of paket) {
    const cur = await getPaketBreakEvenStat(p);
    const prev = await db.paket.findUnique({
      where: { id: p.clonedFromId },
      select: {
        id: true, slug: true, title: true, departureDate: true,
        kursiTotal: true, costPerPaxIdr: true,
      },
    });
    const prevStat = prev ? await getPaketBreakEvenStat(prev) : null;
    let deltaDays = null;
    let pctFaster = null;
    if (cur.brokeEven && prevStat?.brokeEven && prevStat.daysToBreakEven > 0) {
      deltaDays = prevStat.daysToBreakEven - cur.daysToBreakEven;
      pctFaster = Math.round((deltaDays / prevStat.daysToBreakEven) * 1000) / 10;
    }
    rows.push({
      paket: { id: p.id, slug: p.slug, title: p.title, departureDate: p.departureDate },
      current: cur,
      previous: prev ? {
        paket: { id: prev.id, slug: prev.slug, title: prev.title, departureDate: prev.departureDate },
        ...prevStat,
      } : null,
      deltaDays, pctFaster,
    });
  }
  // Sort: paket with the most-improved comparison first (highest pctFaster)
  rows.sort((a, b) => {
    if (a.pctFaster == null && b.pctFaster == null) return 0;
    if (a.pctFaster == null) return 1;
    if (b.pctFaster == null) return -1;
    return b.pctFaster - a.pctFaster;
  });
  return { rows, minLunas: MIN_LUNAS };
}
