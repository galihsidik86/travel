// Stage 176 — per-paket break-even tracker. Projects "N more LUNAS
// bookings until cost is covered" using the existing S22 / S39 cost
// + komisi math.
//
// Per-pax break-even formula:
//   marginPerPax = avgRevenuePerPax - costPerPax - avgKomisiPerPax
//   booksNeeded  = max(0, ceil(remainingCost / marginPerPax))
//
// Uses averages from already-LUNAS bookings on this paket so the
// projection reflects the agent mix actually selling the trip (high-
// komisi-rate agents pull marginPerPax down). When there are zero
// LUNAS bookings yet, falls back to the featured PaketHarga price +
// the paket's komisiRate so the widget still surfaces on day 1.
//
// Returns null when costPerPaxIdr is unset (admin hasn't tracked
// vendor cost — no break-even target exists).

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const DEFAULT_KOMISI_RATE = 0.06;

export async function getPaketBreakEven({ paketId }) {
  if (!paketId) return null;
  const [paket, lunas, komisi, featuredPrice] = await Promise.all([
    db.paket.findUnique({
      where: { id: paketId },
      select: {
        id: true, slug: true, title: true,
        costPerPaxIdr: true, kursiTotal: true, kursiTerisi: true,
        komisiRate: true, departureDate: true,
      },
    }),
    db.booking.findMany({
      where: { paketId, status: 'LUNAS' },
      select: { totalAmount: true, paxCount: true },
    }),
    db.komisi.findMany({
      where: { booking: { paketId }, status: { in: ['EARNED', 'PAID'] } },
      select: { amount: true },
    }),
    db.paketHarga.findFirst({
      where: { paketId, isFeatured: true },
      select: { priceIdr: true, kelas: true },
    }),
  ]);
  if (!paket) return null;
  const costPerPaxIdr = toNumber(paket.costPerPaxIdr);
  if (costPerPaxIdr == null) {
    // No cost tracked → no break-even target. Return a minimal
    // shape so the view can show a "butuh cost per pax" hint
    // without 500-ing on undefined.
    return { paket, hasCost: false };
  }

  const lunasRevenueIdr = lunas.reduce((acc, b) => acc + (toNumber(b.totalAmount) ?? 0), 0);
  const lunasPaxCount = lunas.reduce((acc, b) => acc + (b.paxCount || 1), 0);
  const komisiLiabilityIdr = komisi.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);
  const totalCostIdr = costPerPaxIdr * lunasPaxCount;
  const netSoFarIdr = lunasRevenueIdr - totalCostIdr - komisiLiabilityIdr;

  // Per-pax averages — falls back to featured price + paket rate when
  // there are no LUNAS bookings yet (day-one projection).
  const fallbackRevPerPax = featuredPrice ? toNumber(featuredPrice.priceIdr) : null;
  const avgRevenuePerPax = lunasPaxCount > 0
    ? lunasRevenueIdr / lunasPaxCount
    : fallbackRevPerPax;
  const avgKomisiPerPax = lunasPaxCount > 0
    ? komisiLiabilityIdr / lunasPaxCount
    : (fallbackRevPerPax ? fallbackRevPerPax * (toNumber(paket.komisiRate) ?? DEFAULT_KOMISI_RATE) : 0);

  // Projection: where do we stand vs costs, and what does the next
  // booking actually contribute to the bottom line?
  let marginPerPax = null;
  let booksNeeded = null;
  let alreadyBreakEven = null;
  if (avgRevenuePerPax != null) {
    marginPerPax = avgRevenuePerPax - costPerPaxIdr - (avgKomisiPerPax || 0);
    if (netSoFarIdr >= 0) {
      alreadyBreakEven = true;
      booksNeeded = 0;
    } else if (marginPerPax > 0) {
      // Negative net + positive marginPerPax → can recover by selling more
      alreadyBreakEven = false;
      booksNeeded = Math.ceil(-netSoFarIdr / marginPerPax);
    } else {
      // Negative net + zero/negative marginPerPax → can't recover by
      // selling more at current pricing. Operator must lift price or
      // cut cost. Surface as null so view shows a warning instead of
      // a misleading number.
      alreadyBreakEven = false;
      booksNeeded = null;
    }
  }

  // Seats left guards the projection — if we say "need 20 more" but
  // only 5 seats remain, the trip can't break even at this price.
  const seatsLeft = Math.max(0, (paket.kursiTotal || 0) - (paket.kursiTerisi || 0));
  const feasible = booksNeeded != null && booksNeeded <= seatsLeft;

  return {
    paket, hasCost: true,
    lunasCount: lunas.length, lunasPaxCount,
    lunasRevenueIdr, totalCostIdr, komisiLiabilityIdr, netSoFarIdr,
    avgRevenuePerPax, avgKomisiPerPax, marginPerPax,
    booksNeeded, alreadyBreakEven, seatsLeft, feasible,
    usingFallback: lunasPaxCount === 0 && fallbackRevPerPax != null,
  };
}
