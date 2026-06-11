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

// Stage 26 — paket waitlist admin queue + promote / cancel actions.
router.get(
  '/:slug/waitlist',
  asyncHandler(async (req, res) => {
    const { listWaitlist } = await import('../services/waitlist.js');
    const data = await listWaitlist(req.params.slug);
    const flash = {
      ok: req.query.ok === 'promoted' ? 'Jemaah berhasil di-promote ke booking.'
        : req.query.ok === 'cancelled' ? 'Waitlist entry dibatalkan.'
        : null,
      err: req.query.err ? decodeURIComponent(req.query.err) : null,
    };
    // Stage 44 — `?promoteOldest=1` from the slot-freed email lights up
    // the oldest WAITING row so the admin can act in one click. Pure UI
    // hint — the actual promotion still goes through the same POST flow.
    const promoteOldest = req.query.promoteOldest === '1';
    let highlightId = null;
    if (promoteOldest && Array.isArray(data.rows)) {
      const oldest = data.rows
        .filter((r) => r.status === 'WAITING')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
      highlightId = oldest?.id || null;
    }
    res.render('paket-waitlist', {
      user: req.user, ...data, flash, promoteOldest, highlightId,
    });
  }),
);
// Stage 174 — CSV export of the per-paket waitlist for offline outreach.
router.get(
  '/:slug/waitlist.csv',
  asyncHandler(async (req, res) => {
    const { buildWaitlistCsv } = await import('../services/waitlist.js');
    const { csv, paket } = await buildWaitlistCsv(req.params.slug);
    const safeSlug = paket.slug.replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="waitlist_${safeSlug}.csv"`);
    res.end(csv);
  }),
);

router.post(
  '/:slug/waitlist/:id/promote',
  asyncHandler(async (req, res) => {
    const { promoteWaitlist } = await import('../services/waitlist.js');
    try {
      await promoteWaitlist({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        id: req.params.id,
        kelas: req.body?.kelas || 'QUAD',
        paxCount: Number(req.body?.paxCount) || 1,
        agentSlug: req.body?.agentSlug || null,
      });
      res.redirect(`/admin/paket/${encodeURIComponent(req.params.slug)}/waitlist?ok=promoted`);
    } catch (err) {
      const msg = err.message || 'Gagal promote';
      res.redirect(`/admin/paket/${encodeURIComponent(req.params.slug)}/waitlist?err=${encodeURIComponent(msg)}`);
    }
  }),
);
router.post(
  '/:slug/waitlist/:id/cancel',
  asyncHandler(async (req, res) => {
    const { cancelWaitlist } = await import('../services/waitlist.js');
    try {
      await cancelWaitlist({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        id: req.params.id,
      });
      res.redirect(`/admin/paket/${encodeURIComponent(req.params.slug)}/waitlist?ok=cancelled`);
    } catch (err) {
      const msg = err.message || 'Gagal cancel';
      res.redirect(`/admin/paket/${encodeURIComponent(req.params.slug)}/waitlist?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 23 — pre-departure readiness checklist per paket.
router.get(
  '/:slug/checklist',
  asyncHandler(async (req, res) => {
    const { getPreDepartureChecklist } = await import('../services/preDepartureChecklist.js');
    const data = await getPreDepartureChecklist(req.params.slug);
    const filter = req.query.filter === 'all' ? 'all' : 'incomplete';
    const visibleRows = filter === 'all'
      ? data.rows
      : data.rows.filter((r) => r.tier !== 'ready');
    res.render('pre-departure-checklist', {
      user: req.user, ...data, filter, visibleRows,
    });
  }),
);

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
    // Stage 22 — Decimal → plain string for the form input. null → '' so
    // the input renders empty and the preprocessor can detect "clear".
    costPerPaxIdr: paket.costPerPaxIdr != null
      ? Number(paket.costPerPaxIdr.toString?.() ?? paket.costPerPaxIdr).toString()
      : '',
    costNotes: paket.costNotes ?? '',
    // Stage 61 — same Decimal → string preprocessing as cost.
    adsSpendIdr: paket.adsSpendIdr != null
      ? Number(paket.adsSpendIdr.toString?.() ?? paket.adsSpendIdr).toString()
      : '',
    adsNotes: paket.adsNotes ?? '',
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
    // Stage 39 — profitability snapshot, used inline next to the cost input.
    const { getPaketProfitabilitySnapshot } = await import('../services/paketProfitability.js');
    // Stage 176 — break-even projector: "N LUNAS until cost is covered".
    const { getPaketBreakEven } = await import('../services/paketBreakEven.js');
    // Stage 50 — A/B breakdown only fetched when variantB is configured;
    // skips an unnecessary query for the common single-variant case.
    // Stage 60 — also load the daily-view sparkline for the trend chart
    // above the hero-title field.
    const { getPaketABBreakdown, getPaketDailyViews } = await import('../services/paketView.js');
    const { listCostLines, COST_CATEGORIES, getCategoryLabel, getCostBenchmarks } = await import('../services/paketCostLines.js');
    const [availableCrew, assignedCrew, availableAgents, paketOverrides, profitability, breakEven, abBreakdown, viewTrend, costLines, costBenchmarks] = await Promise.all([
      listAvailableCrew(),
      listAssignedCrewForPaket(req.params.slug),
      db.agentProfile.findMany({
        where: { user: { status: 'ACTIVE', deletedAt: null } },
        select: { id: true, slug: true, displayName: true },
        orderBy: { slug: 'asc' },
      }),
      listPaketOverrides(req.params.slug),
      getPaketProfitabilitySnapshot(paket.id),
      getPaketBreakEven({ paketId: paket.id }),
      paket.heroTitleHtmlVariantB ? getPaketABBreakdown({ paketId: paket.id }) : Promise.resolve(null),
      getPaketDailyViews({ paketId: paket.id, days: 30 }),
      listCostLines(paket.id),
      getCostBenchmarks({ paketId: paket.id }),
    ]);
    res.render('paket-form', {
      user: req.user, mode: 'edit', paket: paketToForm(paket),
      errors: {}, formError: null,
      availableCrew, assignedCrew,
      availableAgents, paketOverrides,
      profitability, breakEven, abBreakdown, viewTrend,
      costLines, costCategories: COST_CATEGORIES, costCategoryLabel: getCategoryLabel,
      costBenchmarks,
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

// Stage 43 — POST /admin/paket/:slug/extend-manifest-close — one-click
// extension of manifestClosesAt from the overview countdown panel.
router.post(
  '/:slug/extend-manifest-close',
  asyncHandler(async (req, res) => {
    const { extendManifestClose } = await import('../services/manifestClose.js');
    const hours = Math.max(1, Math.min(168, Number(req.body?.hours) || 24));
    const updated = await extendManifestClose({ slug: req.params.slug, hours });
    if (!updated) return res.redirect('/admin?tab=overview&err=paket_not_found');
    res.redirect('/admin?tab=overview&ok=manifest_extended');
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
