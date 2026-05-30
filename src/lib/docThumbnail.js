// Cached document thumbnails (sharp).
//
// The view previously rendered docs as <img src="…/file"> scaled by CSS to
// 64px. That downloads the full 2-5 MB JPEG/PNG every time — fine on desktop,
// painful on phones over 3G. This module pre-resizes to ≤ 256 px (jpeg q80)
// at upload time and caches at private/docs/<jemaahId>/thumbs/<docId>.jpg.
//
// Thumbnails are best-effort: a failure to generate (sharp throws on a
// corrupt image, etc.) logs a warning but never aborts the upload. The
// download route falls back to the full file when the thumb is missing, so
// pre-thumbnail docs keep working unchanged.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { absFromRel, projectRoot, isInlineImageMime } from './docStorage.js';

const THUMB_MAX_DIM = 256;
const THUMB_QUALITY = 80;

/**
 * Where the cached thumb lives, relative to projectRoot. Thumbs are always
 * JPEG regardless of source (uniform; smallest acceptable size for the
 * 256-px target). Suffix `.jpg` is hard-coded.
 */
export function thumbRelPath({ jemaahId, docId }) {
  return path.posix.join('private', 'docs', jemaahId, 'thumbs', `${docId}.jpg`);
}

export function thumbAbsPath({ jemaahId, docId }) {
  return absFromRel(thumbRelPath({ jemaahId, docId }));
}

/**
 * Generate (or re-generate) the thumbnail for a stored doc file.
 * Returns { ok: true, bytes } on success; { ok: false, reason } when the
 * source mime is not an inline image; throws only on filesystem errors
 * that prevented even attempting (mkdir failure etc.).
 *
 * Pass the same mime that was validated on upload — we don't sniff.
 */
export async function generateThumbnail({ jemaahId, docId, srcRel, mime }) {
  if (!isInlineImageMime(mime)) {
    return { ok: false, reason: 'mime-not-image', mime };
  }
  const src = absFromRel(srcRel);
  const dest = thumbAbsPath({ jemaahId, docId });
  await fs.mkdir(path.dirname(dest), { recursive: true });

  // `failOn: 'truncated'` lets sharp recover from many real-world quirks
  // (slightly malformed JPEGs from phone cameras) instead of throwing.
  await sharp(src, { failOn: 'truncated' })
    .rotate()                                         // honour EXIF orientation
    .resize({
      width: THUMB_MAX_DIM, height: THUMB_MAX_DIM,
      fit: 'inside', withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toFile(dest);

  const stat = await fs.stat(dest);
  return { ok: true, bytes: stat.size, path: thumbRelPath({ jemaahId, docId }) };
}

/**
 * Delete the cached thumb for a doc. Best-effort — missing files are not
 * an error. Used by deleteFile / deleteDoc paths so the thumbs directory
 * doesn't leak entries after a doc is removed.
 */
export async function deleteThumbnail({ jemaahId, docId }) {
  const dest = thumbAbsPath({ jemaahId, docId });
  try { await fs.unlink(dest); } catch { /* missing-ok */ }
}

/**
 * Probe: does the cached thumb exist on disk? Used by the download route to
 * decide between serving the thumb vs falling back to the full file for
 * pre-thumbnail (legacy) uploads.
 */
export async function thumbExists({ jemaahId, docId }) {
  try {
    await fs.access(thumbAbsPath({ jemaahId, docId }));
    return true;
  } catch { return false; }
}

// Re-export for callers that just need the inline-mime check (so they don't
// have to import from two files).
export { isInlineImageMime, projectRoot };
