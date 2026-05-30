import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAdminOverview, getManifestForPaket, getFinanceSummary,
  exportManifestCsv, getPrintManifest,
} from '../services/adminDashboard.js';
import { getBunkingForPaket } from '../services/bunking.js';

const router = Router();

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

router.use(requireAuth, requireRole(...ADMIN_ROLES));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const range = { from: req.query.from || '', to: req.query.to || '' };
    const overview = await getAdminOverview(range);
    const manifestSlug = req.query.manifestPaket
      || overview.paketList[0]?.slug
      || null;
    const bunkingSlug = req.query.bunkingPaket
      || overview.paketList[0]?.slug
      || null;
    const [manifest, finance, bunking] = await Promise.all([
      manifestSlug ? getManifestForPaket(manifestSlug) : Promise.resolve(null),
      getFinanceSummary(),
      bunkingSlug ? getBunkingForPaket(bunkingSlug) : Promise.resolve(null),
    ]);
    res.render('admin-dashboard', {
      user: req.user,
      ...overview,
      manifest,
      finance,
      bunking,
      activeTab: req.query.tab || 'overview',
      range,
    });
  }),
);

router.get(
  '/manifest/:slug/export.csv',
  asyncHandler(async (req, res) => {
    const out = await exportManifestCsv(req.params.slug);
    if (!out) return res.status(404).type('text/plain').send('Paket tidak ditemukan');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
  }),
);

// Stage 19 — print-friendly manifest (A4 worksheet for airport check-in).
router.get(
  '/manifest/:slug/print',
  asyncHandler(async (req, res) => {
    const data = await getPrintManifest(req.params.slug);
    if (!data) return res.status(404).type('text/plain').send('Paket tidak ditemukan');
    res.render('print-manifest', { user: req.user, ...data });
  }),
);

export default router;
