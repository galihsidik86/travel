import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAdminOverview, getManifestForPaket, getFinanceSummary,
  exportManifestCsv, getPrintManifest,
} from '../services/adminDashboard.js';
import { getBunkingForPaket } from '../services/bunking.js';
import { getPaketWeeklyRecap } from '../services/paketWeeklyRecap.js';
import { getRefundDetails } from '../services/refundAnalytics.js';

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
    // Stage 32 — per-paket weekly recap. Default to first ACTIVE paket
    // so the panel always renders something useful on first paint.
    const recapSlug = req.query.recapPaket
      || overview.paketList.find((p) => p.status === 'ACTIVE')?.slug
      || overview.paketList[0]?.slug
      || null;
    const { getMyMentions } = await import('../services/bookingMentions.js');
    const { getMyOpenTasks } = await import('../services/tasks.js');
    const [manifest, finance, bunking, paketRecap, myMentions, myTasks] = await Promise.all([
      manifestSlug ? getManifestForPaket(manifestSlug) : Promise.resolve(null),
      getFinanceSummary(),
      bunkingSlug ? getBunkingForPaket(bunkingSlug) : Promise.resolve(null),
      recapSlug ? getPaketWeeklyRecap({ slug: recapSlug }) : Promise.resolve(null),
      getMyMentions({ userEmail: req.user.email, days: 30 })
        .catch((err) => { console.warn('[admin] getMyMentions failed:', err?.message || err); return null; }),
      // Stage 91 — viewer's open tasks. Best-effort.
      getMyOpenTasks({ assigneeEmail: req.user.email })
        .catch((err) => { console.warn('[admin] getMyOpenTasks failed:', err?.message || err); return null; }),
    ]);
    res.render('admin-dashboard', {
      user: req.user,
      ...overview,
      manifest,
      finance,
      bunking,
      paketRecap,
      recapSlug,
      myMentions,
      myTasks,
      activeTab: req.query.tab || 'overview',
      range,
    });
  }),
);

// Stage 38 — refund drill-down. Either ?paket=<slug> or ?agent=<slug>
// (use `kantor-pusat` for walk-ins). Days override via ?days=N.
router.get(
  '/refunds',
  asyncHandler(async (req, res) => {
    const paketSlug = req.query.paket || null;
    const agentSlug = req.query.agent || null;
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 90));
    if (!paketSlug && !agentSlug) {
      return res.redirect('/admin?tab=overview');
    }
    const details = await getRefundDetails({ paketSlug, agentSlug, days });
    res.render('refund-detail', {
      user: req.user,
      paketSlug, agentSlug, days,
      ...details,
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

// Stage 91 — task complete/cancel. POST-only state transitions; same RBAC
// as the rest of /admin (any of 4 admin roles can mark their own tasks).
router.post(
  '/tasks/:id/complete',
  asyncHandler(async (req, res) => {
    const { completeTask } = await import('../services/tasks.js');
    // Anyone in the 4 admin roles can mark a task DONE — they help each
    // other clear queues. completedByEmail records who did it.
    await completeTask({ id: req.params.id, actor: { id: req.user.id, email: req.user.email } });
    res.redirect(req.body?._back || '/admin');
  }),
);

router.post(
  '/tasks/:id/cancel',
  asyncHandler(async (req, res) => {
    const { cancelTask } = await import('../services/tasks.js');
    await cancelTask({ id: req.params.id, actor: { id: req.user.id, email: req.user.email } });
    res.redirect(req.body?._back || '/admin');
  }),
);

// Stage 84/85 — per-URL click heatmap drill-down for one notif type.
// ?channel=EMAIL|WA narrows the lens; omit for combined view.
router.get(
  '/email-ctr/:type',
  asyncHandler(async (req, res) => {
    const { getEmailClickHeatmap } = await import('../services/emailCtr.js');
    const channelQ = (req.query.channel || '').toString().toUpperCase();
    const channel = (channelQ === 'EMAIL' || channelQ === 'WA') ? channelQ : null;
    const heatmap = await getEmailClickHeatmap({ type: req.params.type, channel, days: 30 });
    res.render('email-ctr-heatmap', { user: req.user, heatmap });
  }),
);

// Stage 24 — month-grid view of paket departures.
router.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const { getDepartureCalendar } = await import('../services/departureCalendar.js');
    const cal = await getDepartureCalendar({
      year: req.query.year, month: req.query.month,
    });
    // Optional drill: ?date=YYYY-MM-DD shows that day's paket below the grid.
    const drillDate = (req.query.date || '').toString();
    const drill = drillDate
      ? cal.days.find((d) => d.date === drillDate) || null
      : null;
    res.render('admin-calendar', { user: req.user, cal, drill });
  }),
);

export default router;
