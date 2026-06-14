// Stage 283 — per-paket add-on catalog.
//
// Admin curates optional extras like "Extra baggage 30kg", "Room
// upgrade Suite", "Optional ziarah Madinah". Each booking can attach
// 0..N add-ons (S284); price is snapshotted at attach time so catalog
// mutations don't retroactively affect existing bookings.
//
// Active/inactive flag: deactivating removes from new-booking pickers
// but keeps existing BookingAddon rows intact (the snapshot is the
// authoritative price for those bookings).

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).trim().slice(0, 120);
}

function cleanPrice(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Resolve paket by slug + return id, or throw 404. */
async function resolvePaketId(paketSlug) {
  const p = await db.paket.findFirst({
    where: { slug: paketSlug, deletedAt: null },
    select: { id: true },
  });
  if (!p) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  return p.id;
}

/**
 * List add-ons for a paket. By default returns all (active + inactive)
 * so the admin curator UI sees everything. Pass `{ activeOnly: true }`
 * when surfacing to the booking attach picker.
 */
export async function listPaketAddons(paketId, { activeOnly = false } = {}) {
  return db.paketAddon.findMany({
    where: {
      paketId,
      ...(activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Create an add-on for a paket.
 *   - `name` required (min 2, max 120 chars)
 *   - `priceIdr` required (non-negative integer Rupiah)
 *   - `sortOrder` defaults to last+10 to keep added rows at the bottom
 *   - `isActive` defaults to true
 */
export async function createPaketAddon({ req, actor, paketSlug, input }) {
  const paketId = await resolvePaketId(paketSlug);
  const name = cleanName(input?.name);
  const price = cleanPrice(input?.priceIdr);
  if (name.length < 2) throw new HttpError(400, 'Nama add-on wajib (min. 2 karakter)', 'ADDON_NAME_REQUIRED');
  if (price == null) throw new HttpError(400, 'Harga add-on harus angka ≥ 0', 'ADDON_BAD_PRICE');

  // Default sortOrder = max + 10 so newly added rows land at the bottom.
  const maxRow = await db.paketAddon.aggregate({
    where: { paketId },
    _max: { sortOrder: true },
  });
  const sortOrder = input?.sortOrder != null
    ? Math.floor(Number(input.sortOrder)) || 0
    : ((maxRow._max.sortOrder ?? 0) + 10);

  const isActive = input?.isActive !== false; // default true
  const created = await db.paketAddon.create({
    data: {
      paketId, name, priceIdr: price.toFixed(2),
      sortOrder, isActive,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'PaketAddon', entityId: created.id,
    after: { paketSlug, name, priceIdr: price, sortOrder, isActive },
  });
  return created;
}

/**
 * Update an add-on. Partial — undefined fields are skipped.
 * Skip-audit-on-no-op when nothing changed.
 */
export async function updatePaketAddon({ req, actor, addonId, input }) {
  const before = await db.paketAddon.findUnique({
    where: { id: addonId },
    select: { id: true, name: true, priceIdr: true, sortOrder: true, isActive: true, paketId: true },
  });
  if (!before) throw new HttpError(404, 'Add-on tidak ditemukan', 'ADDON_NOT_FOUND');

  const data = {};
  if (input?.name !== undefined) {
    const name = cleanName(input.name);
    if (name.length < 2) throw new HttpError(400, 'Nama add-on wajib (min. 2 karakter)', 'ADDON_NAME_REQUIRED');
    if (name !== before.name) data.name = name;
  }
  if (input?.priceIdr !== undefined) {
    const price = cleanPrice(input.priceIdr);
    if (price == null) throw new HttpError(400, 'Harga add-on harus angka ≥ 0', 'ADDON_BAD_PRICE');
    if (price !== Number(before.priceIdr.toString())) data.priceIdr = price.toFixed(2);
  }
  if (input?.sortOrder !== undefined) {
    const so = Math.floor(Number(input.sortOrder)) || 0;
    if (so !== before.sortOrder) data.sortOrder = so;
  }
  if (input?.isActive !== undefined) {
    const a = input.isActive === true || input.isActive === 'true' || input.isActive === 'on';
    if (a !== before.isActive) data.isActive = a;
  }
  if (Object.keys(data).length === 0) {
    return { updated: false, addon: before };
  }
  const updated = await db.paketAddon.update({ where: { id: addonId }, data });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'PaketAddon', entityId: addonId,
    before: {
      name: before.name,
      priceIdr: Number(before.priceIdr.toString()),
      sortOrder: before.sortOrder,
      isActive: before.isActive,
    },
    after: { changed: Object.keys(data), ...data },
  });
  return { updated: true, addon: updated };
}

/**
 * Delete an add-on from the catalog. Existing BookingAddon rows
 * stay (FK is SetNull). UI surfaces deleted add-ons in the booking
 * detail as "deleted from catalog" via the nameSnapshot column.
 */
export async function deletePaketAddon({ req, actor, addonId }) {
  const before = await db.paketAddon.findUnique({
    where: { id: addonId },
    select: { id: true, name: true, paketId: true },
  });
  if (!before) throw new HttpError(404, 'Add-on tidak ditemukan', 'ADDON_NOT_FOUND');
  await db.paketAddon.delete({ where: { id: addonId } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'PaketAddon', entityId: addonId,
    before: { name: before.name, paketId: before.paketId },
  });
  return { deleted: true };
}

export { resolvePaketId };
