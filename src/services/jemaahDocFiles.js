// 5mm: file upload / download / delete for JemaahDocument attachments.
// Kept separate from jemaahPortal.js to isolate filesystem side effects.
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import {
  ALLOWED_MIME, MAX_DOC_BYTES,
  moveUploadedFile, deleteStoredFile, sanitiseBasename, absFromRel,
} from '../lib/docStorage.js';

/**
 * Attach (or replace) a file on a doc owned by `userId`.
 * Re-upload deletes the previous file on disk. Status side-effect: if the doc
 * was PENDING, attaching a file transitions it to SUBMITTED (mirrors
 * `submitMyDoc` semantics where presence of an attachment = "I've submitted it").
 * VERIFIED docs allow re-upload but **reset to SUBMITTED** so staff re-reviews
 * (same as text re-submit in submitMyDoc).
 */
export async function uploadMyDocFile({ req, actor, userId, docId, file }) {
  if (!file) throw new HttpError(400, 'File wajib di-upload', 'FILE_REQUIRED');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new HttpError(400, `Tipe ${file.mimetype} tidak diizinkan`, 'INVALID_FILE_TYPE');
  }
  if (file.size > MAX_DOC_BYTES) {
    throw new HttpError(400, `File terlalu besar (maks ${MAX_DOC_BYTES / 1024 / 1024} MB)`, 'FILE_TOO_LARGE');
  }

  const doc = await db.jemaahDocument.findUnique({
    where: { id: docId },
    include: { jemaah: { select: { userId: true, id: true } } },
  });
  if (!doc || doc.jemaah.userId !== userId) {
    throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  }

  const relPath = await moveUploadedFile({
    tmpPath: file.path,
    jemaahId: doc.jemaahId,
    docId: doc.id,
    originalName: file.originalname,
    mime: file.mimetype,
    previousRel: doc.filePath,
  });

  const nextStatus = doc.status === 'PENDING' ? 'SUBMITTED'
    : doc.status === 'VERIFIED' ? 'SUBMITTED'
    : doc.status;
  const statusChanged = nextStatus !== doc.status;
  const nowIso = new Date();

  const updated = await db.jemaahDocument.update({
    where: { id: doc.id },
    data: {
      filePath: relPath,
      fileName: `${sanitiseBasename(file.originalname)}`,
      fileSize: file.size,
      mimeType: file.mimetype,
      fileUploadedAt: nowIso,
      ...(statusChanged ? { status: nextStatus, submittedAt: nowIso } : {}),
      // Clear stale verdict if we just kicked it back to SUBMITTED
      ...(doc.status === 'VERIFIED' ? { verifiedAt: null, verifiedById: null } : {}),
    },
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'JemaahDocument', entityId: doc.id,
    before: { status: doc.status, hasFile: !!doc.filePath },
    after: {
      status: updated.status,
      fileName: updated.fileName,
      fileSize: updated.fileSize,
      mimeType: updated.mimeType,
      fileUploaded: true,
      selfSubmit: true,
    },
  });
  return updated;
}

/**
 * Remove the file attachment (keeps the doc row + refNumber/notes).
 * Refuses on VERIFIED docs — staff verdict is a soft lock (same rule as
 * `deleteMyDoc`).
 */
export async function deleteMyDocFile({ req, actor, userId, docId }) {
  const doc = await db.jemaahDocument.findUnique({
    where: { id: docId },
    include: { jemaah: { select: { userId: true } } },
  });
  if (!doc || doc.jemaah.userId !== userId) {
    throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  }
  if (doc.status === 'VERIFIED') {
    throw new HttpError(409, 'Dokumen sudah VERIFIED — hubungi admin', 'DOC_LOCKED');
  }
  if (!doc.filePath) {
    throw new HttpError(404, 'Tidak ada file untuk dihapus', 'NO_FILE');
  }
  await deleteStoredFile(doc.filePath);
  const updated = await db.jemaahDocument.update({
    where: { id: doc.id },
    data: { filePath: null, fileName: null, fileSize: null, mimeType: null, fileUploadedAt: null },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'JemaahDocument', entityId: doc.id,
    before: { hasFile: true, fileName: doc.fileName },
    after: { hasFile: false, fileDeleted: true, selfSubmit: true },
  });
  return updated;
}

/**
 * Resolve a doc for download by the calling jemaah. Returns the absolute
 * path + display name + mime, or throws 404 if not owned / not present.
 */
export async function getMyDocFileMeta({ userId, docId }) {
  const doc = await db.jemaahDocument.findUnique({
    where: { id: docId },
    include: { jemaah: { select: { userId: true } } },
  });
  if (!doc || doc.jemaah.userId !== userId) {
    throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  }
  if (!doc.filePath) throw new HttpError(404, 'Belum ada file', 'NO_FILE');
  return { absPath: absFromRel(doc.filePath), fileName: doc.fileName, mimeType: doc.mimeType };
}

/**
 * Admin variant of the download resolver. Caller already passed RBAC at the
 * router layer; we still verify the (jemaahId, docId) path tuple matches
 * (prevents enumerating files across jemaah by guessing docId on the wrong URL).
 */
export async function getJemaahDocFileMeta({ jemaahId, docId }) {
  const doc = await db.jemaahDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.jemaahId !== jemaahId) {
    throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  }
  if (!doc.filePath) throw new HttpError(404, 'Belum ada file', 'NO_FILE');
  return { absPath: absFromRel(doc.filePath), fileName: doc.fileName, mimeType: doc.mimeType };
}
