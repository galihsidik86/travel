// Stage 389 — Doa CMS service. Admin CRUD + jemaah read-only list.
//
// Audio storage rules:
// - `audioPath` = relative filename under shared/audio/doa/ — local upload
//   (multer middleware writes file; this service just persists the name).
// - `audioUrl`  = external URL (CDN, YouTube direct mp3, Google Drive direct).
// - `videoUrl`  = external embed URL ONLY (YouTube/Vimeo) — no upload path.
//
// Exactly one of audioPath/audioUrl should be set per doa (admin picks);
// neither set = no audio (TTS fallback on PWA side).

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';
import { audit } from '../lib/audit.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';

const SHARED_AUDIO_DIR = path.resolve(process.cwd(), 'shared/audio/doa');

// ─── Validation ─────────────────────────────────────────────────────

const DoaSchema = z.object({
  title: z.string().trim().min(2, 'Title minimal 2 karakter').max(200),
  arabic: z.preprocess((v) => (v === '' ? null : v), z.string().nullish()).optional(),
  latin: z.preprocess((v) => (v === '' ? null : v), z.string().nullish()).optional(),
  translation: z.preprocess((v) => (v === '' ? null : v), z.string().nullish()).optional(),
  // audioPath dikelola via upload route, bukan via form ini
  audioUrl: z.preprocess((v) => (v === '' ? null : v), z.string().url('audioUrl harus URL valid').nullish()).optional(),
  videoUrl: z.preprocess((v) => (v === '' ? null : v), z.string().url('videoUrl harus URL valid').nullish()).optional(),
  category: z.preprocess((v) => (v === '' ? null : v), z.string().max(60).nullish()).optional(),
  credit: z.preprocess((v) => (v === '' ? null : v), z.string().max(255).nullish()).optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.preprocess((v) => v === true || v === 'true' || v === 'on' || v === '1', z.boolean()).optional(),
});

// ─── Read ───────────────────────────────────────────────────────────

/**
 * Public-ish read used by jemaah PWA via /api/saya/doa.
 * Returns active doa with sortOrder then createdAt asc.
 */
export async function listActiveDoa() {
  return db.doa.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, title: true, arabic: true, latin: true, translation: true,
      audioPath: true, audioUrl: true, videoUrl: true, category: true, credit: true,
    },
  });
}

/**
 * Admin list — includes inactive rows + audit fields.
 */
export async function listAllDoa({ category } = {}) {
  return db.doa.findMany({
    where: category ? { category } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    include: {
      createdBy: { select: { email: true } },
    },
  });
}

export async function getDoa(id) {
  if (!id) return null;
  return db.doa.findUnique({
    where: { id },
    include: { createdBy: { select: { email: true } } },
  });
}

// ─── Write ──────────────────────────────────────────────────────────

export async function createDoa({ data, actor, req }) {
  const parsed = DoaSchema.parse(data);
  const row = await db.doa.create({
    data: {
      title: parsed.title,
      arabic: parsed.arabic ?? null,
      latin: parsed.latin ?? null,
      translation: parsed.translation ?? null,
      audioUrl: parsed.audioUrl ?? null,
      videoUrl: parsed.videoUrl ?? null,
      category: parsed.category ?? null,
      credit: parsed.credit ?? null,
      sortOrder: parsed.sortOrder,
      isActive: parsed.isActive ?? true,
      createdById: actor?.id || null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'Doa', entityId: row.id,
    before: null,
    after: { title: row.title, category: row.category, isActive: row.isActive },
  });
  return row;
}

export async function updateDoa({ id, data, actor, req }) {
  const existing = await db.doa.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Doa tidak ditemukan', 'DOA_NOT_FOUND');
  const parsed = DoaSchema.parse(data);
  const next = {
    title: parsed.title,
    arabic: parsed.arabic ?? null,
    latin: parsed.latin ?? null,
    translation: parsed.translation ?? null,
    audioUrl: parsed.audioUrl ?? null,
    videoUrl: parsed.videoUrl ?? null,
    category: parsed.category ?? null,
    credit: parsed.credit ?? null,
    sortOrder: parsed.sortOrder,
    isActive: parsed.isActive ?? true,
  };
  const row = await db.doa.update({ where: { id }, data: next });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Doa', entityId: id,
    before: { title: existing.title, category: existing.category, isActive: existing.isActive },
    after: { title: row.title, category: row.category, isActive: row.isActive },
  });
  return row;
}

export async function deleteDoa({ id, actor, req }) {
  const existing = await db.doa.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Doa tidak ditemukan', 'DOA_NOT_FOUND');
  // Delete associated uploaded audio file if any.
  if (existing.audioPath) {
    try {
      await fs.unlink(path.join(SHARED_AUDIO_DIR, existing.audioPath));
    } catch (_err) { /* best-effort */ }
  }
  await db.doa.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Doa', entityId: id,
    before: { title: existing.title, audioPath: existing.audioPath },
    after: null,
  });
  return { deleted: true };
}

// ─── Audio file upload ──────────────────────────────────────────────

/**
 * Persist uploaded MP3 file to shared/audio/doa/<id>__<safe-filename>.mp3
 * Multer middleware places the file at req.file.path (temp dir).
 * Move to permanent location + persist audioPath on doa row.
 */
export async function attachAudioFile({ id, file, actor, req }) {
  const existing = await db.doa.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Doa tidak ditemukan', 'DOA_NOT_FOUND');
  if (!file) throw new HttpError(400, 'File belum di-upload', 'NO_FILE');

  // Sanitise filename → ASCII + lowercase, fall back to "audio.mp3".
  const orig = String(file.originalname || 'audio.mp3');
  const safe = orig
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'audio.mp3';
  const targetName = `${id}__${safe.endsWith('.mp3') ? safe : safe + '.mp3'}`;
  const targetPath = path.join(SHARED_AUDIO_DIR, targetName);

  await fs.mkdir(SHARED_AUDIO_DIR, { recursive: true });
  // Delete previous audio file if any (replace mode).
  if (existing.audioPath) {
    try { await fs.unlink(path.join(SHARED_AUDIO_DIR, existing.audioPath)); } catch (_e) {}
  }
  await fs.rename(file.path, targetPath);

  const row = await db.doa.update({
    where: { id },
    data: {
      audioPath: targetName,
      // Setting an uploaded file implies clearing any prior audioUrl —
      // exactly one source per doa supaya jemaah PWA pick clear.
      audioUrl: null,
    },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Doa', entityId: id,
    before: { audioPath: existing.audioPath, audioUrl: existing.audioUrl },
    after: { audioPath: row.audioPath, audioUrl: null },
  });
  return row;
}

/**
 * Remove the uploaded MP3 (and clear audioPath). Doesn't touch audioUrl.
 */
export async function removeAudioFile({ id, actor, req }) {
  const existing = await db.doa.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Doa tidak ditemukan', 'DOA_NOT_FOUND');
  if (!existing.audioPath) return existing; // no-op
  try {
    await fs.unlink(path.join(SHARED_AUDIO_DIR, existing.audioPath));
  } catch (_e) { /* best-effort */ }
  const row = await db.doa.update({ where: { id }, data: { audioPath: null } });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Doa', entityId: id,
    before: { audioPath: existing.audioPath },
    after: { audioPath: null },
  });
  return row;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Resolve effective audio URL for jemaah PWA — uploaded file path or
 * external URL. Returns null when neither set.
 */
export function effectiveAudioUrl(doa) {
  if (!doa) return null;
  if (doa.audioPath) return `/shared/audio/doa/${doa.audioPath}`;
  return doa.audioUrl || null;
}
