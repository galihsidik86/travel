// Stage 53 — traffic anomaly detector. For each ACTIVE future-departure
// paket, compare yesterday's unique-visit count vs the trailing 7-day
// mean (excluding yesterday). When yesterday drops ≥50% AND the 7-day
// mean was at least 5 visits (so a 1→0 drop on a sleepy paket doesn't
// fire false alarms), flag the row.
//
// Pairs with stage 48 (conversion funnel) — that's the always-on view;
// this is the push notification when something breaks ("ads paused",
// "campaign expired", "competitor outranked us").

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;
const MIN_BASELINE_VISITS = 5;
const DROP_THRESHOLD = 0.5; // 50% drop = anomaly

function localMidnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export async function getTrafficAnomalies({ now = new Date() } = {}) {
  const today = localMidnight(now);
  const yesterdayStart = new Date(today.getTime() - ONE_DAY_MS);
  // Baseline = 7 days ending the day before yesterday (so yesterday isn't
  // in the average it's being compared to)
  const baselineEnd = yesterdayStart;
  const baselineStart = new Date(baselineEnd.getTime() - 7 * ONE_DAY_MS);

  const paket = await db.paket.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      departureDate: { gte: today },
    },
    select: { id: true, slug: true, title: true, kursiTotal: true, kursiTerisi: true },
  });
  if (paket.length === 0) return { rows: [], counts: { total: 0 } };

  const paketIds = paket.map((p) => p.id);

  // Single grouped query covers both windows; bucket in JS by createdAt.
  const views = await db.paketView.findMany({
    where: {
      paketId: { in: paketIds },
      createdAt: { gte: baselineStart, lt: today },
    },
    select: { paketId: true, createdAt: true },
  });

  const stats = new Map(); // paketId → { yesterday, baselineSum, baselineDays:Set<dayIdx> }
  for (const v of views) {
    const row = stats.get(v.paketId) || { yesterday: 0, baselineCount: 0 };
    if (v.createdAt >= yesterdayStart) {
      row.yesterday += 1;
    } else {
      row.baselineCount += 1;
    }
    stats.set(v.paketId, row);
  }

  const rows = [];
  for (const p of paket) {
    const s = stats.get(p.id) || { yesterday: 0, baselineCount: 0 };
    const baselineMean = s.baselineCount / 7;
    // Threshold: require baseline ≥ MIN_BASELINE_VISITS so a sleepy paket
    // doesn't fire. Also require a real drop, not zero-vs-zero.
    if (baselineMean < MIN_BASELINE_VISITS) continue;
    const dropPct = baselineMean > 0
      ? Math.round((1 - s.yesterday / baselineMean) * 100)
      : 0;
    if (dropPct < DROP_THRESHOLD * 100) continue;
    rows.push({
      paket: p,
      yesterday: s.yesterday,
      baselineMean: Math.round(baselineMean * 10) / 10,
      dropPct,
    });
  }
  // Sort worst-drop first
  rows.sort((a, b) => b.dropPct - a.dropPct);

  return {
    rows,
    counts: { total: rows.length },
    thresholds: {
      minBaselineVisits: MIN_BASELINE_VISITS,
      dropThresholdPct: Math.round(DROP_THRESHOLD * 100),
    },
  };
}
