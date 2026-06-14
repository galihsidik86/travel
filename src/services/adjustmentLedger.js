// Stage 297 — admin overview ledger of recent adjustments.
//
// Two rollups:
//   - perReason: total amount per reasonCode (split by kind so admin
//     sees how much was discounted vs surcharged for each reason)
//   - topActors: top 5 admins who added adjustments in the window
//
// Window: trailing N days (default 90). Excludes adjustments on
// CANCELLED/REFUNDED bookings — those bookings are frozen and the
// adjustment's effect on totalAmount is moot.

import { db } from '../lib/db.js';

const DEFAULT_DAYS = 90;

function n(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

export async function getAdjustmentLedger({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await db.bookingAdjustment.findMany({
    where: {
      createdAt: { gte: cutoff },
      booking: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    },
    select: {
      kind: true, amountIdr: true, reasonCode: true,
      createdByEmail: true, createdAt: true,
    },
  });

  if (rows.length === 0) {
    return {
      days,
      perReason: [],
      topActors: [],
      totals: { discountIdr: 0, surchargeIdr: 0, netIdr: 0, rowCount: 0 },
    };
  }

  // perReason
  const reasonMap = new Map();
  for (const r of rows) {
    const amt = Math.round(n(r.amountIdr));
    if (!reasonMap.has(r.reasonCode)) {
      reasonMap.set(r.reasonCode, {
        reasonCode: r.reasonCode,
        discountCount: 0, surchargeCount: 0,
        discountIdr: 0, surchargeIdr: 0,
      });
    }
    const e = reasonMap.get(r.reasonCode);
    if (r.kind === 'DISCOUNT') {
      e.discountCount += 1;
      e.discountIdr += amt;
    } else {
      e.surchargeCount += 1;
      e.surchargeIdr += amt;
    }
  }
  const perReason = [...reasonMap.values()].map((e) => ({
    ...e,
    netIdr: e.surchargeIdr - e.discountIdr, // surcharge is positive impact, discount is negative
  }));
  // Sort by absolute total movement (largest dollar impact first)
  perReason.sort((a, b) => (b.discountIdr + b.surchargeIdr) - (a.discountIdr + a.surchargeIdr));

  // topActors
  const actorMap = new Map();
  for (const r of rows) {
    const email = r.createdByEmail || '(unknown)';
    if (!actorMap.has(email)) {
      actorMap.set(email, { email, count: 0, totalAbsIdr: 0 });
    }
    const e = actorMap.get(email);
    e.count += 1;
    e.totalAbsIdr += Math.round(n(r.amountIdr));
  }
  const topActors = [...actorMap.values()]
    .sort((a, b) => b.totalAbsIdr - a.totalAbsIdr)
    .slice(0, 5);

  const totals = perReason.reduce((acc, e) => ({
    discountIdr: acc.discountIdr + e.discountIdr,
    surchargeIdr: acc.surchargeIdr + e.surchargeIdr,
    netIdr: acc.netIdr + e.netIdr,
    rowCount: acc.rowCount + e.discountCount + e.surchargeCount,
  }), { discountIdr: 0, surchargeIdr: 0, netIdr: 0, rowCount: 0 });

  return { days, perReason, topActors, totals };
}
