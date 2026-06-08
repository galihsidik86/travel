// Stage 63 — testimonial CRUD admin routes. Mounted at /admin/testimonials.
import { Router } from 'express';
import { ZodError } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import {
  listTestimonials, getTestimonialById,
  createTestimonial, updateTestimonial, deleteTestimonial,
} from '../services/testimonialAdmin.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

function zodToErrors(err) {
  const out = {};
  for (const i of err.issues) {
    const p = i.path.join('.');
    if (!(p in out)) out[p] = i.message;
  }
  return out;
}

function emptyTestimonial() {
  return {
    id: null, paketId: '', jemaahName: '', jemaahCity: '',
    body: '', rating: 5, photoUrl: '', status: 'DRAFT', sortOrder: 0,
    paket: null,
  };
}

async function loadActivePaket() {
  return db.paket.findMany({
    where: { status: { not: 'ARCHIVED' }, deletedAt: null },
    select: { id: true, slug: true, title: true },
    orderBy: { title: 'asc' },
  });
}

// List
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status === 'PUBLISHED' || req.query.status === 'DRAFT' ? req.query.status : null;
    const rows = await listTestimonials({ status });
    const flash = {
      ok: req.query.ok === 'created'  ? 'Testimonial dibuat.'
        : req.query.ok === 'updated'  ? 'Testimonial disimpan.'
        : req.query.ok === 'deleted'  ? 'Testimonial dihapus.'
        : null,
    };
    res.render('testimonial-list', { user: req.user, rows, status, flash });
  }),
);

// New form
router.get(
  '/new',
  asyncHandler(async (req, res) => {
    const paketOptions = await loadActivePaket();
    res.render('testimonial-form', {
      user: req.user, mode: 'new', t: emptyTestimonial(),
      paketOptions, errors: {}, formError: null,
    });
  }),
);

// Edit form
router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const t = await getTestimonialById(req.params.id);
    if (!t) throw new HttpError(404, 'Testimonial tidak ditemukan', 'NOT_FOUND');
    const paketOptions = await loadActivePaket();
    res.render('testimonial-form', {
      user: req.user, mode: 'edit',
      t: { ...t, paketId: t.paketId || '' },
      paketOptions, errors: {}, formError: null,
    });
  }),
);

// Create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const t = await createTestimonial({ req, actor: actorFrom(req), input: req.body });
      res.redirect(`/admin/testimonials/${t.id}/edit?ok=created`);
    } catch (err) {
      if (err instanceof ZodError) {
        const paketOptions = await loadActivePaket();
        return res.status(400).render('testimonial-form', {
          user: req.user, mode: 'new',
          t: { ...emptyTestimonial(), ...req.body },
          paketOptions, errors: zodToErrors(err),
          formError: 'Periksa kembali isian form.',
        });
      }
      throw err;
    }
  }),
);

// Update
router.post(
  '/:id',
  asyncHandler(async (req, res) => {
    try {
      await updateTestimonial({ req, actor: actorFrom(req), id: req.params.id, input: req.body });
      res.redirect(`/admin/testimonials/${req.params.id}/edit?ok=updated`);
    } catch (err) {
      if (err instanceof ZodError) {
        const paketOptions = await loadActivePaket();
        return res.status(400).render('testimonial-form', {
          user: req.user, mode: 'edit',
          t: { ...req.body, id: req.params.id },
          paketOptions, errors: zodToErrors(err),
          formError: 'Periksa kembali isian form.',
        });
      }
      throw err;
    }
  }),
);

// Delete
router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    await deleteTestimonial({ req, actor: actorFrom(req), id: req.params.id });
    res.redirect('/admin/testimonials?ok=deleted');
  }),
);

export default router;
