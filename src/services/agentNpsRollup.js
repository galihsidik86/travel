// Stage 313 — per-agent NPS rollup. Mirror of the S311 admin /admin/nps
// service but scoped to ONE agent's bookings, so agents see their own
// quality signal on /agen?tab=analytics without seeing other agents'
// numbers.
//
// Same MIN_SAMPLE guard as S311 — a single 6 from a tiny paket would
// dominate the screen otherwise. Returns null perPaket rows for paket
// with sample < 5 so the view renders them dimmed.

import { db } from '../lib/db.js';
import { bucketFor, MIN_SAMPLE } from './tripFeedback.js';

const DEFAULT_DAYS = 365;

export async function getAgentNpsRollup({
  agentId, days = DEFAULT_DAYS, now = new Date(), minSample = MIN_SAMPLE,
} = {}) {
  if (!agentId) {
    return {
      days, total: 0,
      overall: { promoters: 0, passives: 0, detractors: 0, npsPct: null },
      perPaket: [],
    };
  }
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  // Pull TripFeedback rows whose booking belongs to this agent. Filter
  // at DB level via the booking relation to avoid loading everything.
  const rows = await db.tripFeedback.findMany({
    where: {
      submittedAt: { gte: cutoff },
      booking: { agentId },
    },
    select: {
      score: true, paketId: true,
      paket: { select: { slug: true, title: true } },
    },
  });
  const total = rows.length;
  if (total === 0) {
    return {
      days, total: 0,
      overall: { promoters: 0, passives: 0, detractors: 0, npsPct: null },
      perPaket: [],
    };
  }
  let prom = 0, pas = 0, det = 0;
  const byPaket = new Map();
  for (const r of rows) {
    const b = bucketFor(r.score);
    if (b === 'promoter') prom += 1;
    else if (b === 'passive') pas += 1;
    else det += 1;
    if (r.paketId) {
      const cur = byPaket.get(r.paketId) || {
        paketId: r.paketId,
        paketSlug: r.paket?.slug || null,
        paketTitle: r.paket?.title || '(paket terhapus)',
        prom: 0, pas: 0, det: 0, total: 0, sum: 0,
      };
      cur.total += 1;
      cur.sum += r.score;
      if (b === 'promoter') cur.prom += 1;
      else if (b === 'passive') cur.pas += 1;
      else cur.det += 1;
      byPaket.set(r.paketId, cur);
    }
  }
  const overallNps = Math.round(((prom - det) / total) * 1000) / 10;

  const perPaket = [...byPaket.values()].map((p) => {
    const enough = p.total >= minSample;
    return {
      paketId: p.paketId,
      paketSlug: p.paketSlug,
      paketTitle: p.paketTitle,
      total: p.total,
      promoters: p.prom, passives: p.pas, detractors: p.det,
      avgScore: Math.round((p.sum / p.total) * 10) / 10,
      npsPct: enough ? Math.round(((p.prom - p.det) / p.total) * 1000) / 10 : null,
      lowSample: !enough,
    };
  });
  // Same sort convention as S311: enough-sample by npsPct desc, then
  // low-sample by total desc.
  perPaket.sort((a, b) => {
    if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
    if (!a.lowSample) return (b.npsPct ?? 0) - (a.npsPct ?? 0);
    return b.total - a.total;
  });

  return {
    days, total,
    overall: { promoters: prom, passives: pas, detractors: det, npsPct: overallNps },
    perPaket,
  };
}
