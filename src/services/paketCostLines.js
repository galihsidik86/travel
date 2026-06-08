// Stage 92 — CRUD for PaketCostLine + auto-sync to Paket.costPerPaxIdr.
//
// Sync rule: when AT LEAST ONE cost line exists for a paket, the lines
// are the source of truth and the column is overwritten with their sum.
// When the LAST line is deleted, the column is NOT cleared — admin may
// want to drop back to a manual estimate; they'll re-enter via the
// existing single-input form. This avoids surprising "I deleted lines
// and lost my margin number" complaints.
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const COST_CATEGORIES = [
  'HOTEL', 'FLIGHT', 'VISA', 'MEALS', 'GROUND_OPS', 'GUIDE', 'INSURANCE', 'OTHER',
];

const CATEGORY_LABELS = {
  HOTEL:      'Hotel',
  FLIGHT:     'Penerbangan',
  VISA:       'Visa',
  MEALS:      'Makan',
  GROUND_OPS: 'Transport darat',
  GUIDE:      'Tim guide / muthawif',
  INSURANCE:  'Asuransi',
  OTHER:      'Lain-lain',
};

export function getCategoryLabel(c) { return CATEGORY_LABELS[c] || c; }

export async function listCostLines(paketId) {
  return db.paketCostLine.findMany({
    where: { paketId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

async function recomputeCost(paketId) {
  const lines = await db.paketCostLine.findMany({
    where: { paketId },
    select: { amountIdr: true },
  });
  if (lines.length === 0) return null;  // see "Sync rule" above — don't clear
  const sum = lines.reduce((s, l) => s + Number(l.amountIdr.toString()), 0);
  await db.paket.update({
    where: { id: paketId },
    data: { costPerPaxIdr: sum.toFixed(2) },
  });
  return sum;
}

export async function addCostLine({ req, actor, paketId, category, amountIdr, vendorNote }) {
  if (!COST_CATEGORIES.includes(category)) {
    throw new HttpError(400, 'Kategori tidak valid', 'BAD_CATEGORY');
  }
  const amt = Number(amountIdr);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new HttpError(400, 'Amount harus angka >= 0', 'BAD_AMOUNT');
  }
  const created = await db.paketCostLine.create({
    data: {
      paketId, category,
      amountIdr: amt.toFixed(2),
      vendorNote: (vendorNote || '').trim() || null,
    },
  });
  const newTotal = await recomputeCost(paketId);
  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaketCostLine', entityId: created.id,
    after: { paketId, category, amountIdr: amt, vendorNote: created.vendorNote, newTotal },
  });
  return { line: created, newTotal };
}

export async function updateCostLine({ req, actor, id, category, amountIdr, vendorNote }) {
  const before = await db.paketCostLine.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Line tidak ditemukan', 'LINE_NOT_FOUND');
  if (category && !COST_CATEGORIES.includes(category)) {
    throw new HttpError(400, 'Kategori tidak valid', 'BAD_CATEGORY');
  }
  const amt = amountIdr !== undefined ? Number(amountIdr) : null;
  if (amt !== null && (!Number.isFinite(amt) || amt < 0)) {
    throw new HttpError(400, 'Amount harus angka >= 0', 'BAD_AMOUNT');
  }
  const updated = await db.paketCostLine.update({
    where: { id },
    data: {
      ...(category ? { category } : {}),
      ...(amt !== null ? { amountIdr: amt.toFixed(2) } : {}),
      ...(vendorNote !== undefined ? { vendorNote: (vendorNote || '').trim() || null } : {}),
    },
  });
  const newTotal = await recomputeCost(before.paketId);
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'PaketCostLine', entityId: id,
    before: { category: before.category, amountIdr: Number(before.amountIdr.toString()) },
    after: { category: updated.category, amountIdr: Number(updated.amountIdr.toString()), newTotal },
  });
  return { line: updated, newTotal };
}

export async function deleteCostLine({ req, actor, id }) {
  const before = await db.paketCostLine.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Line tidak ditemukan', 'LINE_NOT_FOUND');
  await db.paketCostLine.delete({ where: { id } });
  const newTotal = await recomputeCost(before.paketId);  // null if no lines remain
  await audit({
    req, actor,
    action: 'DELETE', entity: 'PaketCostLine', entityId: id,
    before: { paketId: before.paketId, category: before.category, amountIdr: Number(before.amountIdr.toString()) },
    after: { newTotal, allLinesRemoved: newTotal === null },
  });
  return { newTotal };
}

/**
 * Cross-paket per-category rollup. Sums by category across all ACTIVE
 * (non-archived, non-deleted) paket. Used by leaderboard insight panel.
 */
/**
 * Stage 95 — outlier detection per cost-line vs network median.
 *
 * For each category that THIS paket has at least one line in, look up
 * the per-paket TOTAL spend in that category across the network and
 * compute the median. Flag this paket's amount as:
 *
 *   - 'high'   when amount >= 2× median
 *   - 'low'    when amount <= 0.5× median (likely missing a sub-line)
 *   - null     within normal range OR sample too small (<3 paket)
 *
 * Why per-paket TOTAL not per-line: admin may have 1 line "Hotel ALL"
 * or 3 lines "Hotel Madinah / Mekkah / Aqsa". Comparing per-line would
 * make the multi-line paket look "low" everywhere; comparing the total
 * per-paket per-category is apples-to-apples.
 *
 * Median (not mean) so a single outrageous outlier in the network
 * doesn't move the benchmark for everyone else.
 */
export async function getCostBenchmarks({ paketId }) {
  if (!paketId) return [];

  // 1. This paket's totals per category
  const myLines = await db.paketCostLine.findMany({
    where: { paketId },
    select: { category: true, amountIdr: true },
  });
  if (myLines.length === 0) return [];

  const myTotals = new Map();
  for (const l of myLines) {
    const prev = myTotals.get(l.category) || 0;
    myTotals.set(l.category, prev + Number(l.amountIdr.toString()));
  }

  // 2. Per-paket totals across the network for the categories we care about
  const categories = [...myTotals.keys()];
  const networkLines = await db.paketCostLine.findMany({
    where: {
      category: { in: categories },
      paket: { deletedAt: null, status: { not: 'ARCHIVED' } },
    },
    select: { paketId: true, category: true, amountIdr: true },
  });

  // Aggregate per (paketId, category)
  const networkByCat = new Map();   // category → Map<paketId, total>
  for (const cat of categories) networkByCat.set(cat, new Map());
  for (const l of networkLines) {
    const pmap = networkByCat.get(l.category);
    if (!pmap) continue;
    const prev = pmap.get(l.paketId) || 0;
    pmap.set(l.paketId, prev + Number(l.amountIdr.toString()));
  }

  // 3. Compute median per category + classify
  function median(arr) {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort((a, z) => a - z);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  const out = [];
  for (const cat of categories) {
    const pmap = networkByCat.get(cat);
    const totals = [...pmap.values()];
    const med = median(totals);
    const myAmount = myTotals.get(cat);
    let flag = null;
    if (totals.length >= 3 && med > 0) {
      if (myAmount >= med * 2) flag = 'high';
      else if (myAmount <= med * 0.5) flag = 'low';
    }
    out.push({
      category: cat,
      label: getCategoryLabel(cat),
      amount: myAmount,
      networkMedian: med,
      networkSample: totals.length,
      deltaPct: (med != null && med > 0)
        ? Math.round((myAmount / med - 1) * 100)
        : null,
      flag,
    });
  }
  // Sort: flagged 'high' first (most urgent), then 'low', then null.
  const flagRank = { high: 0, low: 1, null: 2 };
  out.sort((a, b) => (flagRank[a.flag] ?? 2) - (flagRank[b.flag] ?? 2));
  return out;
}

export async function getCostByCategoryAcrossPaket() {
  const rows = await db.paketCostLine.groupBy({
    by: ['category'],
    _sum: { amountIdr: true },
    _count: { _all: true },
    where: {
      paket: { deletedAt: null, status: { not: 'ARCHIVED' } },
    },
  });
  const total = rows.reduce((s, r) => s + Number(r._sum.amountIdr?.toString() || 0), 0);
  return rows
    .map((r) => ({
      category: r.category,
      label: getCategoryLabel(r.category),
      amountIdr: Number(r._sum.amountIdr?.toString() || 0),
      lineCount: r._count._all,
      sharePct: total > 0
        ? Math.round((Number(r._sum.amountIdr?.toString() || 0) / total) * 1000) / 10
        : null,
    }))
    .sort((a, b) => b.amountIdr - a.amountIdr);
}
