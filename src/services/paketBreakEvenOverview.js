// Stage 252 — network-wide break-even surface for admin overview.
// Calls S176 `getPaketBreakEven` on every ACTIVE future-departure paket
// that has costPerPaxIdr set + at least one LUNAS or active booking.
// Sorted by "urgency": paket that needs more LUNAS bookings to break
// even, with departure imminent, surface first.
//
// Hidden from view when zero candidates (no real-estate waste on quiet
// weeks where every paket is already break-even).

import { db } from '../lib/db.js';
import { getPaketBreakEven } from './paketBreakEven.js';

const ONE_DAY_MS = 86_400_000;

export async function getNetworkBreakEvenOverview({ now = new Date() } = {}) {
  // Pre-filter to keep S176 calls bounded — only paket with cost data
  // (otherwise S176 returns null) AND ACTIVE + future departure.
  const candidates = await db.paket.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      departureDate: { gte: now },
      costPerPaxIdr: { not: null },
    },
    select: { id: true, slug: true, title: true, departureDate: true },
    orderBy: { departureDate: 'asc' },
  });

  if (candidates.length === 0) return { rows: [], totals: { paketCount: 0 } };

  const rows = [];
  for (const c of candidates) {
    try {
      const be = await getPaketBreakEven({ paketId: c.id });
      if (!be) continue;
      // Surface paket that need admin attention:
      //   - marginPerPax < 0: every LUNAS booking loses money (admin must
      //     raise price OR cut cost). S176 sets `booksNeeded=0` for these
      //     when net=0 but the signal is still actionable.
      //   - booksNeeded > 0: more LUNAS needed and still feasible.
      // Skip truly-OK paket (booksNeeded=0 AND marginPerPax>0).
      const marginNegative = be.marginPerPax != null && be.marginPerPax < 0;
      if (be.booksNeeded === 0 && !marginNegative) continue;
      if (be.booksNeeded == null && !marginNegative) continue;
      const daysToDeparture = c.departureDate
        ? Math.ceil((new Date(c.departureDate).getTime() - now.getTime()) / ONE_DAY_MS)
        : null;
      // Derived feasibility for the overview: negative margin per pax
      // is its own kind of infeasible (admin must change pricing), not
      // just "won't fit in seats". Treat margin-negative as `feasible:false`
      // so it bubbles to the top of the sort.
      const derivedFeasible = marginNegative ? false : (be.feasible !== false);
      rows.push({
        paket: { id: c.id, slug: c.slug, title: c.title, departureDate: c.departureDate },
        daysToDeparture,
        booksNeeded: be.booksNeeded,
        seatsLeft: be.seatsLeft,
        feasible: derivedFeasible,
        marginNegative,
        netSoFarIdr: be.netSoFarIdr,
        marginPerPax: be.marginPerPax,
        avgRevenuePerPax: be.avgRevenuePerPax,
      });
    } catch (err) {
      console.warn('[breakEvenOverview]', c.slug, err?.message || err);
    }
  }

  // Sort: infeasible (won't fill) first, then by daysToDeparture asc
  // (closest paket first). Admin's most actionable rows bubble up.
  rows.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? 1 : -1;
    const da = a.daysToDeparture ?? Infinity;
    const db_ = b.daysToDeparture ?? Infinity;
    return da - db_;
  });

  return {
    rows: rows.slice(0, 10),
    totals: {
      paketCount: rows.length,
      infeasibleCount: rows.filter((r) => !r.feasible).length,
    },
  };
}
