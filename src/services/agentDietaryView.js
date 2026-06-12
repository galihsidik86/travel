// Stage 241 — agen-facing dietary view for their own bookings on
// soon-departing paket. Mirrors S211/S213/S214 (admin CSV, crew brief
// email, crew panel) but scoped to ONE agen — they see who in their
// pool needs special meals so they can call the jemaah to confirm
// before the kitchen brief.
//
// Scope: bookings where `agentId === agentId` (no Kantor Pusat
// fallback — that bucket is admin's, not the agen's). Active bookings
// only (CANCELLED/REFUNDED excluded). Default window 14 days like S213.
//
// Returns per-paket rows so agen can scan multiple soon-departing
// trips at once. Each row carries `{paket, totalPax, specialPax,
// tally, specials[]}` — same shape as S214 dietarySummary for
// view-template reuse.

import { db } from '../lib/db.js';

export const DIETARY_LABELS = {
  REGULAR: 'Reguler',
  VEGETARIAN: 'Vegetarian',
  HALAL_STRICT: 'Halal ketat',
  SOFT_TEXTURE: 'Tekstur lembut (lansia)',
  DIABETIC: 'Diabetes (rendah gula)',
  OTHER: 'Lainnya',
};

export async function getAgentDietaryView({ agentId, now = new Date(), windowDays = 14 } = {}) {
  if (!agentId) return { paket: [], totalPax: 0, totalSpecialPax: 0 };
  const cutoff = new Date(now.getTime() + windowDays * 86_400_000);

  // Pull all the agen's active bookings on near-departure paket with
  // jemaah dietary info. One query — paket grouping done in JS.
  const bookings = await db.booking.findMany({
    where: {
      agentId,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: {
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        departureDate: { gte: now, lte: cutoff },
      },
    },
    select: {
      id: true, bookingNo: true, paxCount: true, kelas: true,
      paket: { select: { id: true, slug: true, title: true, departureDate: true } },
      jemaah: { select: { fullName: true, phone: true, dietary: true, dietaryNotes: true } },
      room: { select: { roomNo: true } },
    },
    orderBy: [{ paket: { departureDate: 'asc' } }, { createdAt: 'asc' }],
  });

  // Group by paket
  const byPaket = new Map();
  for (const b of bookings) {
    const key = b.paket.id;
    if (!byPaket.has(key)) {
      byPaket.set(key, {
        paket: b.paket,
        bookings: [],
        tally: new Map(),
        totalPax: 0,
      });
    }
    const bucket = byPaket.get(key);
    bucket.bookings.push(b);
    const d = b.jemaah?.dietary || 'REGULAR';
    bucket.tally.set(d, (bucket.tally.get(d) || 0) + (b.paxCount || 1));
    bucket.totalPax += (b.paxCount || 1);
  }

  // Build per-paket rows
  const paketRows = [...byPaket.values()].map((bucket) => {
    const specials = bucket.bookings
      .filter((b) => (b.jemaah?.dietary || 'REGULAR') !== 'REGULAR')
      .sort((a, b) => {
        const da = a.jemaah.dietary || '';
        const db_ = b.jemaah.dietary || '';
        if (da !== db_) return da.localeCompare(db_);
        return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
      });
    return {
      paket: bucket.paket,
      totalPax: bucket.totalPax,
      specialPax: specials.reduce((acc, b) => acc + (b.paxCount || 1), 0),
      tally: Object.fromEntries(bucket.tally),
      specials,
    };
  });

  // Sort: paket with specials first (sorted by departure asc), then
  // paket with only REGULAR (also by departure asc). Trips needing
  // attention bubble up.
  paketRows.sort((a, b) => {
    const aHasSpecial = a.specialPax > 0;
    const bHasSpecial = b.specialPax > 0;
    if (aHasSpecial !== bHasSpecial) return aHasSpecial ? -1 : 1;
    return new Date(a.paket.departureDate).getTime() - new Date(b.paket.departureDate).getTime();
  });

  return {
    paket: paketRows,
    totalPax: paketRows.reduce((acc, r) => acc + r.totalPax, 0),
    totalSpecialPax: paketRows.reduce((acc, r) => acc + r.specialPax, 0),
  };
}
