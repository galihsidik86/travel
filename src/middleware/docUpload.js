// 5mm: multer middleware for document uploads.
//
// Writes incoming files to OS temp via multer disk storage, then the route
// handler calls `moveUploadedFile()` to relocate them into private/docs/<jemaahId>/.
// This two-step keeps the multer storage layer agnostic of jemaahId/docId
// (which we only know after auth + route param resolution).
//
// Limits:
//   - Single file per request, field name `file`.
//   - 8 MB body cap (matches ALLOWED_MIME budget for paspor scans).
//   - Mime allowlist enforced in fileFilter; rejections surface as HttpError 400.
import multer from 'multer';
import os from 'node:os';
import { ALLOWED_MIME, MAX_DOC_BYTES } from '../lib/docStorage.js';
import { HttpError } from './error.js';

const storage = multer.diskStorage({
  destination: os.tmpdir(),
  // multer's default name is fine — we move + rename in the service.
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_DOC_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new HttpError(400, `Tipe file ${file.mimetype} tidak diizinkan. Pakai PDF / JPG / PNG / WEBP / HEIC.`, 'INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

// Wrap multer's single-file handler so size-limit + filter errors come through
// the global error handler with proper HttpError shape.
export function uploadSingleDoc(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, `File terlalu besar (maks ${MAX_DOC_BYTES / 1024 / 1024} MB)`, 'FILE_TOO_LARGE'));
    }
    return next(new HttpError(400, `Upload gagal: ${err.message}`, 'UPLOAD_FAILED'));
  });
}
