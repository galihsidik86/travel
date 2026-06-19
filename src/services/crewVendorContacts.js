// Stage 374 — per-paket vendor / hotel / emergency contact book.
//
// Crew on the ground call hotel front desk, bus charter, ambulance, KBRI,
// clinic — AT LEAST as often as they call jemaah ICE contacts (S361). The
// contacts shift per-paket (different hotel in Madinah for VVIP vs Quad,
// different bus charter, sometimes different ground operator), so storage
// is per-paket. Admin authors on paket-edit; crew reads from
// `/crew/paket/:slug` with tel:/wa.me deep links for one-tap call.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const VENDOR_CATEGORIES = [
  'HOTEL', 'BUS', 'AMBULANCE', 'CLINIC',
  'EMBASSY', 'RESTAURANT', 'GUIDE', 'OTHER',
];

export const CATEGORY_LABELS = {
  HOTEL: 'Hotel',
  BUS: 'Bus / Charter',
  AMBULANCE: 'Ambulans',
  CLINIC: 'Klinik / RS',
  EMBASSY: 'KBRI / Embassy',
  RESTAURANT: 'Restoran',
  GUIDE: 'Pemandu lokal',
  OTHER: 'Lain-lain',
};

const VendorContactSchema = z.object({
  category: z.enum(VENDOR_CATEGORIES),
  label: z.string().min(2, 'Label minimal 2 karakter').max(120),
  phone: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(30).nullable().optional(),
  ),
  whatsapp: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(30).nullable().optional(),
  ),
  address: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(500).nullable().optional(),
  ),
  notes: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().max(2000).nullable().optional(),
  ),
  sortOrder: z.preprocess(
    (v) => (v === '' || v == null ? 0 : Number(v)),
    z.number().int().min(0).max(9999).default(0),
  ),
});

export async function listVendorContacts(paketId) {
  return db.crewVendorContact.findMany({
    where: { paketId },
    orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function createVendorContact({ req, actor, paketId, input }) {
  const data = VendorContactSchema.parse(input);
  // Refuses if at least one of phone/whatsapp is not set — a contact with
  // no number is operationally useless. Address-only contacts can be
  // captured as notes on an existing row.
  if (!data.phone && !data.whatsapp) {
    throw new HttpError(400, 'Minimal salah satu dari Telepon atau WhatsApp wajib diisi', 'CONTACT_REQUIRED');
  }
  const paket = await db.paket.findUnique({
    where: { id: paketId }, select: { id: true, slug: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  const row = await db.crewVendorContact.create({
    data: {
      paketId,
      category: data.category,
      label: data.label,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
      sortOrder: data.sortOrder ?? 0,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'CrewVendorContact', entityId: row.id,
    after: { paketSlug: paket.slug, category: row.category, label: row.label },
  });
  return row;
}

export async function updateVendorContact({ req, actor, paketId, id, input }) {
  const existing = await db.crewVendorContact.findUnique({ where: { id } });
  if (!existing || existing.paketId !== paketId) {
    throw new HttpError(404, 'Kontak tidak ditemukan', 'NOT_FOUND');
  }
  const data = VendorContactSchema.parse(input);
  if (!data.phone && !data.whatsapp) {
    throw new HttpError(400, 'Minimal salah satu dari Telepon atau WhatsApp wajib diisi', 'CONTACT_REQUIRED');
  }
  const updated = await db.crewVendorContact.update({
    where: { id },
    data: {
      category: data.category,
      label: data.label,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
      sortOrder: data.sortOrder ?? 0,
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'CrewVendorContact', entityId: id,
    before: { category: existing.category, label: existing.label },
    after: { category: updated.category, label: updated.label },
  });
  return updated;
}

export async function deleteVendorContact({ req, actor, paketId, id }) {
  const existing = await db.crewVendorContact.findUnique({ where: { id } });
  if (!existing || existing.paketId !== paketId) {
    throw new HttpError(404, 'Kontak tidak ditemukan', 'NOT_FOUND');
  }
  await db.crewVendorContact.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'CrewVendorContact', entityId: id,
    before: { category: existing.category, label: existing.label, paketId },
  });
  return { ok: true };
}
