// Stage 196 — per-paket pickup points. Admin curates; jemaah sees the
// list on /saya/bookings/:id and admin reads them on the manifest.
//
// `departTime` is stored as a `HH:MM` string (loose validation — admin
// might enter "05:30 WIB" or similar; we accept both freeform). For now
// just trim/cap; could tighten to strict 24h later if needed.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const PickupSchema = z.object({
  label: z.string().min(2, 'Label minimal 2 karakter').max(80),
  address: z.string().min(5, 'Alamat minimal 5 karakter').max(500),
  // Loose validation — accept any short string up to 5 chars
  // (HH:MM is 5; if admin types "5:00" we accept too).
  departTime: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim().slice(0, 5)),
    z.string().nullable().optional(),
  ).optional(),
  notes: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(2000).nullable().optional(),
  ).optional(),
  sortOrder: z.preprocess(
    (v) => (v === '' || v == null ? 0 : Number(v)),
    z.number().int().min(0).max(9999).default(0),
  ),
  // Stage 212 — max pax-count cap. NULL = no cap. Clamp 1..200 so
  // a typo can't accidentally lock everyone out.
  maxCapacity: z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().int().min(1).max(200).nullable().optional(),
  ),
});

export async function listPickups(paketId) {
  return db.paketPickup.findMany({
    where: { paketId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Stage 212 — same list as `listPickups` but with `occupiedPax` + `isFull`
 * decorated per row. Used by `/saya/bookings/:id` so jemaah see a "PENUH"
 * badge on bus pickups that have hit `maxCapacity`. One groupBy roundtrip
 * instead of N — fine even with 10+ pickups.
 */
export async function listPickupsWithOccupancy(paketId) {
  const pickups = await db.paketPickup.findMany({
    where: { paketId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  if (pickups.length === 0) return pickups;
  const tally = await db.booking.groupBy({
    by: ['pickupId'],
    where: {
      paketId,
      pickupId: { in: pickups.map((p) => p.id) },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    _sum: { paxCount: true },
  });
  const occ = new Map(tally.map((t) => [t.pickupId, t._sum.paxCount || 0]));
  return pickups.map((p) => {
    const occupiedPax = occ.get(p.id) || 0;
    const isFull = p.maxCapacity != null && occupiedPax >= p.maxCapacity;
    return { ...p, occupiedPax, isFull };
  });
}

export async function createPickup({ req, actor, paketId, input }) {
  const data = PickupSchema.parse(input);
  const paket = await db.paket.findUnique({
    where: { id: paketId }, select: { id: true, slug: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  const row = await db.paketPickup.create({
    data: {
      paketId,
      label: data.label, address: data.address,
      departTime: data.departTime ?? null,
      notes: data.notes ?? null,
      sortOrder: data.sortOrder ?? 0,
      maxCapacity: data.maxCapacity ?? null,
    },
  });
  await audit({
    req, actor, action: 'CREATE',
    entity: 'PaketPickup', entityId: row.id,
    after: { paketSlug: paket.slug, label: row.label, departTime: row.departTime },
  });
  return row;
}

export async function updatePickup({ req, actor, id, input }) {
  const before = await db.paketPickup.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'Pickup tidak ditemukan', 'PICKUP_NOT_FOUND');
  const data = PickupSchema.parse(input);
  const row = await db.paketPickup.update({
    where: { id },
    data: {
      label: data.label, address: data.address,
      departTime: data.departTime ?? null,
      notes: data.notes ?? null,
      sortOrder: data.sortOrder ?? 0,
      maxCapacity: data.maxCapacity ?? null,
    },
  });
  await audit({
    req, actor, action: 'UPDATE',
    entity: 'PaketPickup', entityId: id,
    before: { label: before.label, address: before.address, departTime: before.departTime },
    after:  { label: row.label,    address: row.address,    departTime: row.departTime },
  });
  return row;
}

export async function deletePickup({ req, actor, id }) {
  const before = await db.paketPickup.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'Pickup tidak ditemukan', 'PICKUP_NOT_FOUND');
  await db.paketPickup.delete({ where: { id } });
  await audit({
    req, actor, action: 'DELETE',
    entity: 'PaketPickup', entityId: id,
    before: { paketSlug: before.paket?.slug, label: before.label },
  });
  return { id, paketId: before.paketId };
}
