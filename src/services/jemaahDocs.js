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
    const { deleteThumbnail } = await import('../lib/docThumbnail.js');
    await deleteStoredFile(doc.filePath);
    await deleteThumbnail({ jemaahId: doc.jemaahId, docId: doc.id });
  }
  await audit({
    req, actor,
    action: 'DELETE', entity: 'JemaahDocument', entityId: docId,
    before: { jemaahId, type: doc.type, status: doc.status, hasFile: !!doc.filePath },
  });
}

/**
 * Stage 248 — bulk verify a set of docIds for one jemaah. Admin ticks
 * multiple doc rows in the jemaah-edit panel and one click flips them
 * all to VERIFIED with stamps.
 *
 * **Per-row failure caught + skipped** — a bad row (already verified,
 * REJECTED, etc.) doesn't abort the batch. Returns
 * `{verified, skipped, failed}` so the UI shows the real counts.
 *
 * `jemaahId` scopes the bulk action: requested doc IDs that don't
 * belong to this jemaah are silently skipped (tuple guard against
 * a forged docId pointing at someone else's doc).
 *
 * Skip-when-already-VERIFIED keeps re-runs idempotent (no audit pollution).
 * REJECTED docs refused (admin should reject again or open the row to
 * re-process — not bulk-flip a rejection).
 */
/**
 * Stage 275 — bulk reject SUBMITTED docs from the cross-jemaah queue.
 * Distinct from S248 `bulkVerifyDocs` (which is per-jemaah on the edit
 * page); here the admin is acting from the global `/admin/docs-pending`
 * queue across MANY jemaah, so no tuple guard — admin owns the trust.
 *
 * Rules:
 *   - Only SUBMITTED rows flip to REJECTED (skip VERIFIED + PENDING + EXPIRED).
 *   - `reason` (min 3 chars) becomes the doc's `notes` field appended with
 *     `[Rejected by admin: <reason>]` so jemaah sees why on /saya.
 *   - Per-row failure caught — bad row doesn't abort the batch.
 *   - Audit row per actually-rejected doc carries `bulkRejected:true` +
 *     the reason so timeline scans can grep the cohort.
 */
export async function bulkRejectDocs({ req, actor, docIds = [], reason }) {
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return { requested: 0, rejected: 0, skipped: 0, failed: 0, skippedReasons: [] };
  }
  if (!reason || String(reason).trim().length < 3) {
    throw new HttpError(400, 'Alasan tolak wajib (min. 3 karakter)', 'REJECT_REASON_REQUIRED');
  }
  const cleanReason = String(reason).trim().slice(0, 500);

  const candidates = await db.jemaahDocument.findMany({
    where: { id: { in: docIds } },
    select: { id: true, status: true, type: true, jemaahId: true, notes: true },
  });
  const skippedReasons = [];
  const eligible = [];
  for (const c of candidates) {
    if (c.status !== 'SUBMITTED') {
      skippedReasons.push({ id: c.id, reason: 'not_submitted', current: c.status });
      continue;
    }
    eligible.push(c);
  }
  // Cap defensively to prevent runaway requests.
  if (eligible.length > 500) {
    throw new HttpError(400, 'Maksimal 500 dokumen per request', 'BATCH_TOO_LARGE');
  }

  let rejected = 0;
  let failed = 0;
  const now = new Date();
  for (const c of eligible) {
    try {
      const beforeNotes = c.notes || '';
      const sep = beforeNotes ? '\n' : '';
      const nextNotes = `${beforeNotes}${sep}[Rejected by admin: ${cleanReason}]`.slice(0, 4000);
      await db.jemaahDocument.update({
        where: { id: c.id },
        data: {
          status: 'REJECTED',
          notes: nextNotes,
          // S70 reuses verifiedAt/verifiedById as the "staff action" stamps —
          // adopt the same convention here so the timeline column doesn't grow.
          verifiedAt: now,
          verifiedById: actor?.id || null,
        },
      });
      await audit({
        req, actor,
        action: 'UPDATE', entity: 'JemaahDocument', entityId: c.id,
        before: { status: c.status, type: c.type },
        after: {
          status: 'REJECTED', type: c.type, jemaahId: c.jemaahId,
          bulkRejected: true, reason: cleanReason,
        },
      });
      rejected += 1;
    } catch (err) {
      console.warn('[bulkRejectDocs]', c.id, err?.message || err);
      failed += 1;
    }
  }
  return {
    requested: docIds.length,
    rejected,
    skipped: docIds.length - candidates.length + skippedReasons.length, // includes missing-from-DB
    failed,
    skippedReasons,
  };
}

export async function bulkVerifyDocs({ req, actor, jemaahId, docIds = [] }) {
  await loadJemaah(jemaahId);
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return { requested: 0, verified: 0, skipped: 0, failed: 0 };
  }
  // Tuple guard — only act on docs belonging to this jemaah
  const candidates = await db.jemaahDocument.findMany({
    where: { id: { in: docIds }, jemaahId },
    select: { id: true, status: true, type: true },
  });
  const eligibleIds = new Set();
  const skippedReasons = [];
  for (const c of candidates) {
    if (c.status === 'VERIFIED') { skippedReasons.push({ id: c.id, reason: 'already_verified' }); continue; }
    if (c.status === 'REJECTED') { skippedReasons.push({ id: c.id, reason: 'rejected' }); continue; }
    eligibleIds.add(c.id);
  }
  const now = new Date();
  let verified = 0;
  let failed = 0;
  for (const id of eligibleIds) {
    try {
      const before = candidates.find((c) => c.id === id);
      const updated = await db.jemaahDocument.update({
        where: { id },
        data: {
          status: 'VERIFIED',
          verifiedAt: now,
          verifiedById: actor?.id || null,
        },
        select: { id: true, type: true, status: true },
      });
      await audit({
        req, actor,
        action: 'UPDATE', entity: 'JemaahDocument', entityId: id,
        before: { status: before?.status, type: before?.type },
        after: { status: 'VERIFIED', type: updated.type, jemaahId, bulkVerified: true },
      });
      verified += 1;
    } catch (err) {
      console.warn('[bulkVerifyDocs]', id, err?.message || err);
      failed += 1;
    }
  }
  return {
    requested: docIds.length,
    verified,
    skipped: docIds.length - candidates.length + skippedReasons.length, // includes cross-jemaah-skipped
    failed,
    skippedReasons,
  };
}
