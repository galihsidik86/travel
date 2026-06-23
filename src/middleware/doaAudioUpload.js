// Stage 389 — multer middleware for doa audio MP3 uploads.
// Mirrors docUpload.js pattern: temp-write then service-move.
import multer from 'multer';
import os from 'node:os';
import { HttpError } from './error.js';

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB cap — doa pendek 5-30s
const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4', // m4a
]);

const storage = multer.diskStorage({ destination: os.tmpdir() });

const upload = multer({
  storage,
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_AUDIO_MIME.has(file.mimetype)) {
      cb(new HttpError(400, `Tipe file ${file.mimetype} tidak diizinkan. Pakai MP3 / M4A.`, 'INVALID_AUDIO_TYPE'));
      return;
    }
    cb(null, true);
  },
});

export function uploadSingleDoaAudio(req, res, next) {
  upload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, `File audio terlalu besar (max ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB)`, 'FILE_TOO_LARGE'));
    }
    return next(new HttpError(400, err.message || 'Upload gagal', 'UPLOAD_FAILED'));
  });
}
