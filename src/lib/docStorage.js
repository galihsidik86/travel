// 5mm: file storage helpers for JemaahDocument uploads.
//
// Layout: <projectRoot>/private/docs/<jemaahId>/<docId>__<sanitised-basename>.<ext>
//
// Decisions:
//   - One file per doc — re-upload replaces the previous file on disk.
//   - Filename embeds docId so multiple jemaah sharing a basename (paspor.pdf)
//     don't collide; also makes orphan-file detection trivial (no docId → orphan).
//   - We sanitise the original basename for the on-disk name AND store the
//     original (sanitised) basename separately on the row for download
//     Content-Disposition. Never trust the raw user filename for either.
//   - Mime allowlist is enforced both in multer (fileFilter) and re-checked in
//     the service before move — defence in depth.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..', '..');
export const docsRoot = path.join(projectRoot, 'private', 'docs');

export const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8 MB
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

// 5vv: mimes browsers can render natively in an <img> tag. HEIC/HEIF support
// is patchy (Safari yes, Chrome/Firefox no), so we render them as a generic
// icon to avoid broken-image squares. PDFs always get the icon — we don't
// inline embed.
const INLINE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export function isInlineImageMime(mime) {
  return INLINE_IMAGE_MIMES.has(mime);
}

const EXT_FROM_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

// Strip path separators, control chars, and any non-portable filename chars.
// Cap to 100 chars so we don't blow past filesystem limits when combined with
// docId prefix + extension.
export function sanitiseBasename(name) {
  const base = path.basename(String(name || ''));
  const stem = base.replace(/\.[^.]+$/, '');
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')          // strip combining marks
    .replace(/[^A-Za-z0-9._-]+/g, '_')        // anything else → _
    .replace(/_+/g, '_')                      // collapse repeats
    .replace(/^[_.-]+|[_.-]+$/g, '')          // trim leading/trailing punct
    .slice(0, 100);
  return cleaned || 'file';
}

export function storedRelPath({ jemaahId, docId, originalName, mime }) {
  const ext = EXT_FROM_MIME[mime] || 'bin';
  const stem = sanitiseBasename(originalName);
  return path.posix.join('private', 'docs', jemaahId, `${docId}__${stem}.${ext}`);
}

export function absFromRel(relPath) {
  return path.resolve(projectRoot, relPath);
}

/**
 * Write the multer-uploaded file (currently at tmpPath) to its final per-jemaah
 * location, returning the relative path stored on the doc row. Removes any
 * previous file at `previousRel` to avoid orphans on replace.
 */
export async function moveUploadedFile({ tmpPath, jemaahId, docId, originalName, mime, previousRel }) {
  const relPath = storedRelPath({ jemaahId, docId, originalName, mime });
  const absDest = absFromRel(relPath);
  await fs.mkdir(path.dirname(absDest), { recursive: true });
  await fs.rename(tmpPath, absDest);

  if (previousRel && previousRel !== relPath) {
    // Best-effort delete; missing files are non-fatal (already cleaned up,
    // path mutated externally, etc.).
    try { await fs.unlink(absFromRel(previousRel)); } catch { /* ignore */ }
  }
  return relPath;
}

export async function deleteStoredFile(relPath) {
  if (!relPath) return;
  try { await fs.unlink(absFromRel(relPath)); } catch { /* ignore */ }
}
