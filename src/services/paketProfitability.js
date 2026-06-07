// Stage 39 — per-paket profitability snapshot, used inline on the
// paket-edit page next to the `costPerPaxIdr` input so the admin can see
// the live impact of editing the cost. Lifetime totals (no date filter)
// so the number doesn't move when the admin opens the form on a Tuesday.
//
// Mirrors the leaderboard math (one source of truth — `marginPct` uses
// the same `(lunasRevenue - totalCost - komisiLiability) / lunasRevenue`
// formula) so editing the cost here changes the leaderboard's pill the
// same way it changes this gauge.

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

export async function getPaketProfitabilitySnapshot(paketId) {
  if (!paketId) return null;
  const [paket, lunas, komisi] = await Promise.all([
    db.paket.findUnique({
      where: { id: paketId },
      select: {
        id: true, slug: true, title: true,
        costPerPaxIdr: true, costNotes: true,
        kursiTotal: true, kursiTerisi: true,
      },
    }),
    db.booking.findMany({
      where: { paketId, status: 'LUNAS' },
      select: { totalAmount: true, paxCount: true },
    }),
    db.komisi.findMany({
      where: {
        booking: { paketId },
        status: { in: ['EARNED', 'PAID'] },
      },
      select: { amount: true },
    }),
  ]);
  if (!paket) return null;

  const lunasRevenueIdr = lunas.reduce(
    (acc, b) => acc + (toNumber(b.totalAmount) ?? 0),
    0,
  );
  const lunasPaxCount = lunas.reduce((acc, b) => acc + (b.paxCount || 1), 0);
  const komisiLiabilityIdr = komisi.reduce(
    (acc, k) => acc + (toNumber(k.amount) ?? 0),
    0,
  );
  const costPerPaxIdr = toNumber(paket.costPerPaxIdr);
  const totalCostIdr = costPerPaxIdr != null ? costPerPaxIdr * lunasPaxCount : null;
  const netMarginIdr = totalCostIdr != null
    ? lunasRevenueIdr - totalCostIdr - komisiLiabilityIdr
    : null;
  const marginPct = totalCostIdr != null && lunasRevenueIdr > 0
    ? Math.round((netMarginIdr / lunasRevenueIdr) * 100)
    : null;

  return {
    paket,
    lunasCount: lunas.length,
    lunasPaxCount,
    lunasRevenueIdr,
    costPerPaxIdr,
    totalCostIdr,
    komisiLiabilityIdr,
    netMarginIdr,
    marginPct,
  };
}
