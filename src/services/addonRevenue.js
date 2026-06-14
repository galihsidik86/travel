// Stage 285 — admin add-on revenue rollup.
//
// Aggregates all BookingAddon rows attached to active bookings (NOT
// IN CANCELLED, REFUNDED) and groups by addon name. Returns per-name
// rows with `{name, attachCount, totalQuantity, revenueIdr, paketCount}`,
// sorted by revenueIdr desc.
//
// Uses nameSnapshot (not addonId) for grouping so deleted-from-catalog
// add-ons still appear in the rollup with their historical names. Two
// add-ons with the same name (e.g. typo "Extra baggage" vs "Extra
// Baggage") will appear as separate rows — feature, not bug, because
// admin can spot the typo.

import { db } from '../lib/db.js';

function n(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

/**
 * Returns `{rows, totals: {attachCount, totalQuantity, revenueIdr}}`.
 * Empty rows + zero totals when no active bookings have add-ons.
 */
export async function getAddonRevenueRollup() {
  const rows = await db.bookingAddon.findMany({
    where: {
      booking: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    },
    select: {
      nameSnapshot: true, priceIdrSnapshot: true, quantity: true,
      booking: { select: { paketId: true } },
    },
  });

  if (rows.length === 0) {
    return {
      rows: [],
      totals: { attachCount: 0, totalQuantity: 0, revenueIdr: 0 },
    };
  }

  // Group by nameSnapshot
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.nameSnapshot)) {
      byName.set(r.nameSnapshot, {
        name: r.nameSnapshot,
        attachCount: 0,
        totalQuantity: 0,
        revenueIdr: 0,
        _paketIds: new Set(),
      });
    }
    const e = byName.get(r.nameSnapshot);
    const lineTotal = n(r.priceIdrSnapshot) * r.quantity;
    e.attachCount += 1;
    e.totalQuantity += r.quantity;
    e.revenueIdr += lineTotal;
    if (r.booking?.paketId) e._paketIds.add(r.booking.paketId);
  }

  const out = [...byName.values()].map((e) => ({
    name: e.name,
    attachCount: e.attachCount,
    totalQuantity: e.totalQuantity,
    revenueIdr: e.revenueIdr,
    paketCount: e._paketIds.size,
  }));
  out.sort((a, b) => b.revenueIdr - a.revenueIdr);

  const totals = out.reduce(
    (acc, r) => ({
      attachCount: acc.attachCount + r.attachCount,
      totalQuantity: acc.totalQuantity + r.totalQuantity,
      revenueIdr: acc.revenueIdr + r.revenueIdr,
    }),
    { attachCount: 0, totalQuantity: 0, revenueIdr: 0 },
  );

  return { rows: out, totals };
}
