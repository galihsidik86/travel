// Stage 373 — file storage for Incident photo evidence.
//
// Layout: <projectRoot>/private/incidents/<incidentId>/photo__<sanitised>.<ext>
//
// Decisions mirror docStorage (5mm):
//   - One file per incident (re-upload replaces). Field is photoPath nullable.
//   - Filename includes a static 'photo' prefix; we don't need docId-style
//     uniqueness inside the per-incident folder. Re-upload sanitises the new
//     name and replaces the previous file on disk.
//   - Image mime allowlist only — incidents are evidence photos, not PDFs.
//   - Best-effort cleanup on delete + on re-upload.
//
// Path conventions match the `private/` prefix already in SENSITIVE_PREFIXES
// (`src/app.js`), so static serving never exposes these files — only the
// auth-guarded admin download route can.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..', '..');
export const incidentsRoot = path.join(projectRoot, 'private', 'incidents');

export const MAX_INCIDENT_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB
export const ALLOWED_INCIDENT_PHOTO_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const EXT_FROM_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function sanitiseBasename(name) {
  const base = path.basename(String(name || ''));
  const stem = base.replace(/\.[^.]+$/, '');
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return cleaned || 'photo';
}

export function absFromRel(relPath) {
  return path.resolve(projectRoot, relPath);
}

function storedRelPath({ incidentId, originalName, mime }) {
  const ext = EXT_FROM_MIME[mime] || 'bin';
  const sanitised = sanitiseBasename(originalName);
  return path.posix.join('private', 'incidents', incidentId, `photo__${sanitised}.${ext}`);
}

/**
 * Move multer temp file into the per-incident folder. Replaces any previous
 * file at `previousRel`. Returns the new relative path stored on the row.
 */
export async function moveIncidentPhoto({ tmpPath, incidentId, originalName, mime, previousRel }) {
  const relPath = storedRelPath({ incidentId, originalName, mime });
  const absDest = absFromRel(relPath);
  await fs.mkdir(path.dirname(absDest), { recursive: true });
  await fs.rename(tmpPath, absDest);
  if (previousRel && previousRel !== relPath) {
    try { await fs.unlink(absFromRel(previousRel)); } catch { /* ignore */ }
  }
  return relPath;
}

export async function deleteIncidentPhoto(relPath) {
  if (!relPath) return;
  try { await fs.unlink(absFromRel(relPath)); } catch { /* ignore */ }
}
