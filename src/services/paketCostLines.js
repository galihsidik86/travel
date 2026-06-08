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
