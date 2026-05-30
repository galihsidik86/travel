import { Router } from 'express';
import { ZodError } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  JemaahSchema, listJemaah, getJemaahById, updateJemaah, META,
} from '../services/jemaahAdmin.js';
import { DOC_TYPES, DOC_STATUSES, DOC_PILL } from '../services/jemaahDocs.js';
import { getJemaahDocFileMeta } from '../services/jemaahDocFiles.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

function zodToErrors(err) {
  const out = {};
  for (const issue of err.issues) {
    const p = issue.path.join('.');
    if (!(p in out)) out[p] = issue.message;
  }
  return out;
}

// ── GET /admin/jemaah (list) ─────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = (req.query.q || '').trim();
    const expiringSoon = req.query.expiringSoon === '1';
    const rows = await listJemaah({ search, expiringSoon });
    res.render('jemaah-list', { user: req.user, rows, search, expiringSoon });
  }),
);

// ── GET /admin/jemaah/:id/edit ───────────────────────────────
router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const jemaah = await getJemaahById(req.params.id);
    if (!jemaah) throw new HttpError(404, 'Jemaah tidak ditemukan', 'JEMAAH_NOT_FOUND');
    const flat = {
      ...jemaah,
      passportExpiry: jemaah.passportExpiry?.toISOString().slice(0, 10) || '',
      birthDate: jemaah.birthDate?.toISOString().slice(0, 10) || '',
    };
    res.render('jemaah-form', {
      user: req.user, target: flat,
      errors: {}, formError: null, META,
      DOC_TYPES, DOC_STATUSES, DOC_PILL,
    });
  }),
);

// ── POST /admin/jemaah/:id (update) ──────────────────────────
router.post(
  '/:id',
  asyncHandler(async (req, res) => {
    try {
      const input = JemaahSchema.parse(req.body);
      await updateJemaah({ req, actor: actorFrom(req), jemaahId: req.params.id, input });
      res.redirect(`/admin/jemaah/${req.params.id}/edit?ok=updated`);
    } catch (err) {
      if (err instanceof ZodError) {
        // Re-render with body (preserve user input)
        const target = { ...req.body, id: req.params.id };
        return res.status(400).render('jemaah-form', {
          user: req.user, target,
          errors: zodToErrors(err), formError: 'Periksa kembali isian form.', META,
          DOC_TYPES, DOC_STATUSES, DOC_PILL,
        });
      }
      if (err instanceof HttpError && (err.status === 409 || err.status === 400)) {
        return res.status(err.status).render('jemaah-form', {
          user: req.user, target: { ...req.body, id: req.params.id },
          errors: { _: err.message }, formError: err.message, META,
          DOC_TYPES, DOC_STATUSES, DOC_PILL,
        });
      }
      throw err;
    }
  }),
);

// ── 5mm: admin download of jemaah doc file ───────────────────
router.get(
  '/:jemaahId/documents/:docId/file',
  asyncHandler(async (req, res) => {
    const meta = await getJemaahDocFileMeta({
      jemaahId: req.params.jemaahId,
      docId: req.params.docId,
    });
    res.type(meta.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${meta.fileName || 'document'}"`);
    res.sendFile(meta.absPath);
  }),
);

// Thumbnail variant — same tuple guard as /file. Falls back to the full file
// when no cached thumb exists (legacy upload or non-image mime).
router.get(
  '/:jemaahId/documents/:docId/thumb',
  asyncHandler(async (req, res) => {
    const meta = await getJemaahDocFileMeta({
      jemaahId: req.params.jemaahId,
      docId: req.params.docId,
      wantThumb: true,
    });
    res.type(meta.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
    res.sendFile(meta.absPath);
  }),
);

export default router;
