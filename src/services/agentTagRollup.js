// Stage 242 — agen-facing booking tag rollup. Same shape as S230
// `getBookingTagRollup` (admin cross-agen) but scoped to ONE agen.
// Lets agen see "I have 3 VIP, 5 LANSIA, 2 HONEYMOON active right now"
// without leaving the Wallet/Analitik tab.
//
// Active bookings only (non-CANCELLED/REFUNDED) on non-archived paket.
// Returns per-tag rows + total.

import { db } from '../lib/db.js';

export async function getAgentTagRollup({ agentId } = {}) {
  if (!agentId) return { tags: [], totalTaggedBookings: 0 };

  const rows = await db.booking.findMany({
    where: {
      agentId,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: { status: { not: 'ARCHIVED' }, deletedAt: null },
      tags: { not: null },
    },
    select: {
      id: true, paxCount: true, tags: true,
      paket: { select: { slug: true, title: true } },
    },
  });

  const map = new Map();
  for (const r of rows) {
    if (!Array.isArray(r.tags)) continue;
    for (const raw of r.tags) {
      if (typeof raw !== 'string') continue;
      const tag = raw.toUpperCase();
      const cur = map.get(tag) || { tag, bookings: 0, paxCount: 0, paketSet: new Set() };
      cur.bookings += 1;
      cur.paxCount += r.paxCount || 1;
      if (r.paket?.title) cur.paketSet.add(r.paket.title);
      map.set(tag, cur);
    }
  }

  const tags = [...map.values()]
    .map((t) => ({
      tag: t.tag,
      bookings: t.bookings,
      paxCount: t.paxCount,
      paketCount: t.paketSet.size,
    }))
    .sort((a, b) => {
      if (b.paxCount !== a.paxCount) return b.paxCount - a.paxCount;
      return a.tag.localeCompare(b.tag);
    });

  return {
    tags,
    totalTaggedBookings: rows.length,
  };
}
