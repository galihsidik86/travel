import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const DOC_TYPES = [
  'PASSPORT', 'VISA_UMROH', 'MANASIK_CERT', 'HEALTH_CERT',
  'VACCINE_MENINGITIS', 'MARRIAGE_CERT', 'FAMILY_CARD', 'OTHER',
];
export const DOC_STATUSES = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED'];

// Short label shown in manifest pills
export const DOC_PILL = {
  PASSPORT: 'P',
  VISA_UMROH: 'V',
  MANASIK_CERT: 'M',
  HEALTH_CERT: 'H',
  VACCINE_MENINGITIS: 'S',  // S = Sehat/vaksin
  MARRIAGE_CERT: 'N',       // N = Nikah
  FAMILY_CARD: 'K',         // K = KK
  OTHER: '?',
};

// Default pills order shown in manifest table (P V M S K)
export const DEFAULT_PILLS = ['PASSPORT', 'VISA_UMROH', 'MANASIK_CERT', 'VACCINE_MENINGITIS', 'FAMILY_CARD'];

const blank = (v) => (v === '' || v == null ? undefined : v);
const optStr = z.preprocess(blank, z.string().max(2000).optional());
const optDate = z.preprocess(
  (v) => (blank(v) === undefined ? null : new Date(String(v))),
  z.date().nullable().optional(),
);

export const DocSchema = z.object({
  type: z.enum(DOC_TYPES),
  status: z.enum(DOC_STATUSES),
  refNumber: optStr,
  expiresAt: optDate,
  notes: optStr,
});

/**
 * Pill colour state per doc — used by manifest table.
 *   verified  → emerald (ok)
 *   submitted → amber (awaiting review)
 *   rejected  → ruby (broken)
 *   expired   → ruby (broken)
 *   pending   → ink (not started)
 *   missing   → ink-dashed (no row in DB)
 */
export function pillState(doc) {
  if (!doc) return 'missing';
  return doc.status.toLowerCase();
}

/**
 * Compute pill summary for one jemaah given its documents.
 * Used by manifest table to render P/V/M/S/K pills.
 */
export function pillsForJemaah(documents) {
  const byType = new Map();
  for (const d of documents || []) byType.set(d.type, d);
  return DEFAULT_PILLS.map((type) => ({
    type,
    label: DOC_PILL[type],
    state: pillState(byType.get(type)),
  }));
}

async function loadJemaah(id) {
  const j = await db.jemaahProfile.findUnique({ where: { id }, select: { id: true } });
  if (!j) throw new HttpError(404, 'Jemaah tidak ditemukan', 'JEMAAH_NOT_FOUND');
  return j;
}

/**
 * Upsert document by composite key (jemaahId, type). Sets verifiedAt/By
 * automatically when transitioning to VERIFIED; sets submittedAt on
 * transition to SUBMITTED.
 */
export async function upsertDoc({ req, actor, jemaahId, input }) {
  await loadJemaah(jemaahId);
  const data = DocSchema.parse(input);

  const existing = await db.jemaahDocument.findUnique({
    where: { jemaahId_type: { jemaahId, type: data.type } },
  });

  const now = new Date();
  const setStamps = {};
  if (data.status === 'SUBMITTED' && (!existing || existing.status !== 'SUBMITTED')) {
    setStamps.submittedAt = now;
  }
  if (data.status === 'VERIFIED' && (!existing || existing.status !== 'VERIFIED')) {
    setStamps.verifiedAt = now;
    setStamps.verifiedById = actor.id;
  }

  const doc = await db.jemaahDocument.upsert({
    where: { jemaahId_type: { jemaahId, type: data.type } },
    update: {
      status: data.status,
      refNumber: data.refNumber ?? null,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes ?? null,
      ...setStamps,
    },
    create: {
      jemaahId,
      type: data.type,
      status: data.status,
      refNumber: data.refNumber ?? null,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes ?? null,
      ...setStamps,
    },
  });

  await audit({
    req, actor,
    action: existing ? 'UPDATE' : 'CREATE',
    entity: 'JemaahDocument', entityId: doc.id,
    before: existing ? { status: existing.status, refNumber: existing.refNumber } : null,
    after: { jemaahId, type: doc.type, status: doc.status, refNumber: doc.refNumber },
  });

  return doc;
}

export async function deleteDoc({ req, actor, jemaahId, docId }) {
  const doc = await db.jemaahDocument.findUnique({ where: { id: docId } });
  if (!doc) throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  if (doc.jemaahId !== jemaahId) {
    throw new HttpError(403, 'Dokumen ini bukan milik jemaah tersebut', 'FORBIDDEN');
  }
  await db.jemaahDocument.delete({ where: { id: docId } });
  // 5mm: clean up the file too — orphaned blobs accumulate fast otherwise.
  // Best-effort; DB delete already succeeded.
  if (doc.filePath) {
    const { deleteStoredFile } = await import('../lib/docStorage.js');
    await deleteStoredFile(doc.filePath);
  }
  await audit({
    req, actor,
    action: 'DELETE', entity: 'JemaahDocument', entityId: docId,
    before: { jemaahId, type: doc.type, status: doc.status, hasFile: !!doc.filePath },
  });
}
