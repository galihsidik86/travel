// Stage 345 — reschedule analytics for /admin overview.
//
// Three lenses over the last `days` window (default 90):
//   1. perPaket — net flow per paket. "out" = jemaah left this paket via
//      reschedule; "in" = jemaah arrived here from another paket via
//      reschedule. Net = in − out. High negative net = leaky paket.
//   2. perReason — breakdown by rescheduleReasonCode (NULL → __UNSET__
//      sentinel, mirrors S175/S236 convention).
//   3. topPairs — most common source→target paket flows. Reveals
//      patterns like "Ramadhan-2026 → Ramadhan-2027" (people delayed
//      from one season to the next).
//
// Read-only; never writes. Same posture as other admin analytics services.

import { db } from '../lib/db.js';

const DEFAULT_DAYS = 90;

const REASON_LABELS = {
  JEMAAH_REQUEST: 'Permintaan jemaah',
  DOCUMENT_DELAY: 'Dokumen telat',
  HEALTH: 'Kesehatan',
  FINANCIAL: 'Finansial',
  PAKET_FULL: 'Paket asal penuh',
  SCHEDULE_CONFLICT: 'Bentrok jadwal',
  OPERATOR_INITIATED: 'Inisiatif operator',
  OTHER: 'Lainnya',
  __UNSET__: 'Belum dikategorikan',
};

export async function getRescheduleAnalytics({
  days = DEFAULT_DAYS, now = new Date(),
} = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);

  // Pull all RESCHEDULED source bookings in the window. Each one has
  // rescheduledToBookingId pointing at the new booking, so we can
  // resolve target paket in a second batched query.
  const sources = await db.booking.findMany({
    where: {
      status: 'RESCHEDULED',
      rescheduledAt: { gte: since },
    },
    select: {
      id: true, bookingNo: true, paketId: true,
      rescheduledToBookingId: true,
      rescheduleReasonCode: true,
      rescheduledAt: true,
      paket: { select: { slug: true, title: true } },
    },
  });

  if (sources.length === 0) {
    return {
      days, total: 0,
      perPaket: [], perReason: [], topPairs: [],
    };
  }

  // Resolve target paket for each source via batched lookup.
  const targetBookingIds = [...new Set(sources.map((s) => s.rescheduledToBookingId).filter(Boolean))];
  const targets = targetBookingIds.length > 0
    ? await db.booking.findMany({
        where: { id: { in: targetBookingIds } },
        select: { id: true, paketId: true, paket: { select: { slug: true, title: true } } },
      })
    : [];
  const targetByBookingId = new Map(targets.map((t) => [t.id, t]));

  // Per-paket flow (out from source, in to target)
  const flowMap = new Map(); // paketId → { paket, out, in }
  function ensure(paketId, paket) {
    if (!flowMap.has(paketId)) {
      flowMap.set(paketId, { paketId, paket, out: 0, in: 0 });
    }
    return flowMap.get(paketId);
  }
  for (const s of sources) {
    if (s.paketId) ensure(s.paketId, s.paket).out += 1;
    const tgt = targetByBookingId.get(s.rescheduledToBookingId);
    if (tgt?.paketId) ensure(tgt.paketId, tgt.paket).in += 1;
  }
  const perPaket = [...flowMap.values()]
    .map((p) => ({
      paketSlug: p.paket?.slug || null,
      paketTitle: p.paket?.title || '(paket terhapus)',
      out: p.out, in: p.in, net: p.in - p.out,
    }))
    // Sort by absolute |net| desc so the biggest flow imbalances surface
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 15);

  // Per-reason breakdown
  const reasonMap = new Map();
  for (const s of sources) {
    const code = s.rescheduleReasonCode || '__UNSET__';
    reasonMap.set(code, (reasonMap.get(code) || 0) + 1);
  }
  const perReason = [...reasonMap.entries()]
    .map(([code, count]) => ({
      code,
      label: REASON_LABELS[code] || code,
      count,
      sharePct: Math.round((count / sources.length) * 1000) / 10,
    }))
    .sort((a, b) => {
      // __UNSET__ always last (mirrors S175 convention)
      if (a.code === '__UNSET__') return 1;
      if (b.code === '__UNSET__') return -1;
      return b.count - a.count;
    });

  // Top source→target pairs (only counts pairs where both ends resolved)
  const pairMap = new Map();
  for (const s of sources) {
    const tgt = targetByBookingId.get(s.rescheduledToBookingId);
    if (!s.paketId || !tgt?.paketId) continue;
    const key = `${s.paketId}→${tgt.paketId}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        sourcePaket: s.paket, targetPaket: tgt.paket, count: 0,
      });
    }
    pairMap.get(key).count += 1;
  }
  const topPairs = [...pairMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    days, total: sources.length,
    perPaket, perReason, topPairs,
  };
}

export { REASON_LABELS };
