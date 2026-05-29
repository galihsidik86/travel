// Browser-facing CRUD for Paket, mounted at /admin/paket.
// Form-encoded; renders the same view (paket-form.ejs) for new + edit + errors.
import { Router } from 'express';
import { ZodError } from 'zod';

import { db } from '../lib/db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  PaketSchema, parsePrices,
  createPaket, updatePaket, softDeletePaket,
} from '../services/paketAdmin.js';

const router = Router();
const KELAS = ['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP'];

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

// Empty scaffold for the create-form initial render
function emptyPaket() {
  return {
    slug: '', title: '', subtitle: '',
    heroTitleHtml: '', arabicTagline: '', translitTagline: '',
    departureDate: '', returnDate: '', durationDays: 14,
    airline: '', airlineCode: '', routeFrom: '', routeTo: '',
    heroDescription: '',
    inclusions: [], exclusions: [],
    kursiTotal: 45, kursiTerisi: 0,
    manifestClosesAt: null,
    status: 'DRAFT',
    komisiRatePct: '6.00', // default 6%
    prices: KELAS.map((kelas) => ({ kelas, label: '', caption: '', priceIdr: '', cicilanIdr: '', cicilanMonths: '', isFeatured: false })),
    hotels: [], days: [], rooms: [],
  };
}

// Shape DB paket → form-ready (textareas, ISO dates, full price grid)
function paketToForm(paket) {
  const byKelas = Object.fromEntries(paket.prices.map((p) => [p.kelas, p]));
  // Decimal(5,4) → percentage string for the form input
  const rate = paket.komisiRate != null ? Number(paket.komisiRate.toString?.() ?? paket.komisiRate) : 0.06;
  return {
    ...paket,
    departureDate: paket.departureDate?.toISOString().slice(0, 10),
    returnDate: paket.returnDate?.toISOString().slice(0, 10),
    manifestClosesAt: paket.manifestClosesAt?.toISOString().slice(0, 16),
    inclusions: paket.inclusions || [],
    exclusions: paket.exclusions || [],
    komisiRatePct: (rate * 100).toFixed(2).replace(/\.?0+$/, ''),
    prices: KELAS.map((kelas) => byKelas[kelas] || { kelas, label: '', caption: '', priceIdr: '', cicilanIdr: '', cicilanMonths: '', isFeatured: false }),
  };
}

// Echo posted form values back on validation failure
function bodyToForm(body) {
  const pricesRaw = body.prices || {};
  return {
    ...body,
    inclusions: (body.inclusionsText || '').split('\n').filter(Boolean),
    exclusions: (body.exclusionsText || '').split('\n').filter(Boolean),
    prices: KELAS.map((kelas) => ({ kelas, ...(pricesRaw[kelas] || {}) })),
    hotels: [], days: [], rooms: [],
  };
}

// Format Zod errors into { fieldName: 'msg' } map
function zodToErrors(err) {
  const out = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

// ── GET /admin/paket/new ─────────────────────────────────────
router.get(
  '/new',
  (req, res) => {
    res.render('paket-form', {
      user: req.user, mode: 'new', paket: emptyPaket(),
      errors: {}, formError: null,
    });
  },
);

// ── GET /admin/paket/:slug/edit ──────────────────────────────
router.get(
  '/:slug/edit',
  asyncHandler(async (req, res) => {
    const paket = await db.paket.findUnique({
      where: { slug: req.params.slug },
      include: {
        prices: true, hotels: true, days: true,
        rooms: {
          orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
          include: {
            bookings: {
              where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
              select: { paxCount: true },
            },
          },
        },
      },
    });
    if (!paket || paket.deletedAt) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
    // 5oo: crew panel data
    const { listAvailableCrew, listAssignedCrewForPaket } = await import('../services/crewPortal.js');
    // Stage 14: per-agent komisi overrides for this paket
    const { listPaketOverrides } = await import('../services/agentPaketKomisi.js');
    const [availableCrew, assignedCrew, availableAgents, paketOverrides] = await Promise.all([
      listAvailableCrew(),
      listAssignedCrewForPaket(req.params.slug),
      db.agentProfile.findMany({
        where: { user: { status: 'ACTIVE', deletedAt: null } },
        select: { id: true, slug: true, displayName: true },
        orderBy: { slug: 'asc' },
      }),
      listPaketOverrides(req.params.slug),
    ]);
    res.render('paket-form', {
      user: req.user, mode: 'edit', paket: paketToForm(paket),
      errors: {}, formError: null,
      availableCrew, assignedCrew,
      availableAgents, paketOverrides,
    });
  }),
);

// ── POST /admin/paket (create) ───────────────────────────────
router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const input = PaketSchema.parse(req.body);
      const prices = parsePrices(req.body.prices);
      const created = await createPaket({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        input, prices,
      });
      res.redirect(`/admin/paket/${created.slug}/edit?ok=created`);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).render('paket-form', {
          user: req.user, mode: 'new', paket: bodyToForm(req.body),
          errors: zodToErrors(err), formError: 'Periksa kembali isian form.',
        });
      }
      if (err instanceof HttpError && err.status === 409) {
        return res.status(409).render('paket-form', {
          user: req.user, mode: 'new', paket: bodyToForm(req.body),
          errors: { slug: err.message }, formError: err.message,
        });
      }
      throw err;
    }
  }),
);

// ── POST /admin/paket/:slug (update) ─────────────────────────
router.post(
  '/:slug',
  asyncHandler(async (req, res) => {
    try {
      const input = PaketSchema.parse(req.body);
      const prices = parsePrices(req.body.prices);
      const updated = await updatePaket({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        slug: req.params.slug, input, prices,
      });
      res.redirect(`/admin/paket/${updated.slug}/edit?ok=updated`);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).render('paket-form', {
          user: req.user, mode: 'edit',
          paket: { ...bodyToForm(req.body), originalSlug: req.params.slug },
          errors: zodToErrors(err), formError: 'Periksa kembali isian form.',
        });
      }
      if (err instanceof HttpError && err.status === 409) {
        return res.status(409).render('paket-form', {
          user: req.user, mode: 'edit',
          paket: { ...bodyToForm(req.body), originalSlug: req.params.slug },
          errors: { slug: err.message }, formError: err.message,
        });
      }
      throw err;
    }
  }),
);

// ── POST /admin/paket/:slug/delete (soft delete) ─────────────
router.post(
  '/:slug/delete',
  asyncHandler(async (req, res) => {
    try {
      await softDeletePaket({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        slug: req.params.slug,
      });
      res.redirect('/admin?tab=packages');
    } catch (err) {
      if (err instanceof HttpError) {
        // Bounce back to the edit page with the error
        return res.redirect(`/admin/paket/${req.params.slug}/edit?err=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }),
);

// ── 5zz: per-paket attendance report (read-only audit) ──────────
router.get(
  '/:slug/attendance',
  asyncHandler(async (req, res) => {
    const { getPaketAttendanceReport } = await import('../services/crewPortal.js');
    const report = await getPaketAttendanceReport(req.params.slug);
    if (!report) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
    res.render('attendance-report', { user: req.user, ...report });
  }),
);

export default router;
