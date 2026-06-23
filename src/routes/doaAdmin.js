// Stage 389 — admin CRUD untuk Doa CMS.
//
// View: 4 admin roles (OWNER/SUPERADMIN/MANAJER_OPS/KASIR view-only di list)
// Write: OWNER+SUPERADMIN+MANAJER_OPS
// Audio file upload: same write tier.

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { uploadSingleDoaAudio } from '../middleware/doaAudioUpload.js';
import {
  listAllDoa, getDoa, createDoa, updateDoa, deleteDoa,
  attachAudioFile, removeAudioFile, effectiveAudioUrl,
} from '../services/doa.js';

const router = Router();
const VIEW_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR'];
const WRITE_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

router.use(requireAuth);

router.get('/', requireRole(...VIEW_ROLES), asyncHandler(async (req, res) => {
  const doas = await listAllDoa({ category: req.query.category || undefined });
  res.render('admin-doa-list', {
    title: 'Doa CMS',
    doas,
    flash: req.query.ok || null,
    err: req.query.err || null,
    effectiveAudioUrl,
  });
}));

router.get('/new', requireRole(...WRITE_ROLES), asyncHandler(async (req, res) => {
  res.render('admin-doa-form', { title: 'Doa baru', doa: null, err: null });
}));

router.post('/', requireRole(...WRITE_ROLES), asyncHandler(async (req, res) => {
  try {
    const row = await createDoa({ data: req.body, actor: req.user, req });
    res.redirect(`/admin/doa/${row.id}/edit?ok=created`);
  } catch (err) {
    if (err.errors) { // Zod
      res.render('admin-doa-form', { title: 'Doa baru', doa: req.body, err: err.errors.map((e) => e.message).join(' · ') });
      return;
    }
    throw err;
  }
}));

router.get('/:id/edit', requireRole(...VIEW_ROLES), asyncHandler(async (req, res) => {
  const doa = await getDoa(req.params.id);
  if (!doa) {
    res.redirect('/admin/doa?err=not_found');
    return;
  }
  res.render('admin-doa-form', {
    title: doa.title,
    doa,
    err: req.query.err || null,
    flash: req.query.ok || null,
    effectiveAudioUrl,
    canWrite: WRITE_ROLES.includes(req.user.role),
  });
}));

router.post('/:id', requireRole(...WRITE_ROLES), asyncHandler(async (req, res) => {
  try {
    await updateDoa({ id: req.params.id, data: req.body, actor: req.user, req });
    res.redirect(`/admin/doa/${req.params.id}/edit?ok=saved`);
  } catch (err) {
    if (err.errors) {
      const doa = await getDoa(req.params.id);
      res.render('admin-doa-form', {
        title: doa?.title || 'Doa',
        doa: { ...doa, ...req.body },
        err: err.errors.map((e) => e.message).join(' · '),
        canWrite: true,
      });
      return;
    }
    throw err;
  }
}));

router.post('/:id/delete', requireRole(...WRITE_ROLES), asyncHandler(async (req, res) => {
  await deleteDoa({ id: req.params.id, actor: req.user, req });
  res.redirect('/admin/doa?ok=deleted');
}));

// Audio file upload — multer first, then service moves + persists.
router.post('/:id/upload-audio',
  requireRole(...WRITE_ROLES),
  uploadSingleDoaAudio,
  asyncHandler(async (req, res) => {
    await attachAudioFile({ id: req.params.id, file: req.file, actor: req.user, req });
    res.redirect(`/admin/doa/${req.params.id}/edit?ok=audio_uploaded`);
  }),
);

router.post('/:id/remove-audio',
  requireRole(...WRITE_ROLES),
  asyncHandler(async (req, res) => {
    await removeAudioFile({ id: req.params.id, actor: req.user, req });
    res.redirect(`/admin/doa/${req.params.id}/edit?ok=audio_removed`);
  }),
);

export default router;
