// Stage 230 — booking tag aggregate KPI for admin overview. Counts
// active (non-CANCELLED/REFUNDED) bookings carrying each tag across
// all non-archived paket. Sort by count desc so the most-tagged
// labels bubble up.
//
// Distinct from S226 (per-booking tag CRUD) — this aggregates them
// for a strategic glance: "how many VIPs are we carrying right now?"

import { db } from '../lib/db.js';

export async function getBookingTagRollup({ now = new Date() } = {}) {
  void now;
  // Single query: active bookings on non-archived non-soft-deleted paket
  // with non-null tags. Filtering tags=not null at the DB layer cuts the
  // result set on real-world dbs where most bookings have NULL.
  const rows = await db.booking.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: { status: { not: 'ARCHIVED' }, deletedAt: null },
      tags: { not: null },
    },
    select: {
      id: true, bookingNo: true, paxCount: true, tags: true,
      paket: { select: { slug: true, title: true } },
    },
  });

  // Per-tag rollup: count of bookings + sum of paxCount + sample paket
  // titles (top 3) so the KPI panel can show "VIP · 5 booking · 8 pax · across 3 paket".
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
    // Sort by paxCount desc (operationally what matters), then by tag asc
    // for stable display.
    .sort((a, b) => {
      if (b.paxCount !== a.paxCount) return b.paxCount - a.paxCount;
      return a.tag.localeCompare(b.tag);
    });

  return {
    tags,
    totalTaggedBookings: rows.length,
  };
}
