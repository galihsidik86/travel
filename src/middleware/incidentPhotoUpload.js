// Stage 373 — multer middleware for incident photo uploads.
//
// Same two-step pattern as docUpload (S5mm): multer writes to OS temp,
// the service moves to private/incidents/<incidentId>/. Image mimes only
// (no PDFs — incidents are evidence photos). 8 MB cap.
//
// IMPORTANT: this middleware is multipart-tolerant — if the request has
// no file part (offline-queued submit replay, or jemaah/crew didn't attach
// one), req.file ends up undefined and the route handler must treat the
// absence as "no photo this time" rather than a hard error.

import multer from 'multer';
import os from 'node:os';
import { ALLOWED_INCIDENT_PHOTO_MIME, MAX_INCIDENT_PHOTO_BYTES } from '../lib/incidentStorage.js';
import { HttpError } from './error.js';

const storage = multer.diskStorage({ destination: os.tmpdir() });

const upload = multer({
  storage,
  limits: { fileSize: MAX_INCIDENT_PHOTO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_INCIDENT_PHOTO_MIME.has(file.mimetype)) {
      cb(new HttpError(400, `Tipe file ${file.mimetype} tidak diizinkan. Pakai JPG / PNG / WEBP / HEIC.`, 'INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

export function uploadIncidentPhoto(req, res, next) {
  // Field name 'photo' — distinct from docs ('file') so the two handlers
  // can be wired independently without confusion.
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, `Foto terlalu besar (maks ${MAX_INCIDENT_PHOTO_BYTES / 1024 / 1024} MB)`, 'FILE_TOO_LARGE'));
    }
    return next(new HttpError(400, `Upload gagal: ${err.message}`, 'UPLOAD_FAILED'));
  });
}
