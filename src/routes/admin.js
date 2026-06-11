import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getAdminOverview, getManifestForPaket, getFinanceSummary, filterManifestByPickup,
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
    const { getAllAgentsCommissionForecast } = await import('../services/agentForecast.js');
    // Stage 205 — pickup filter on manifest tab
    const manifestPickupId = (req.query.manifestPickup || '').toString();
    const [manifestRaw, finance, bunking, paketRecap, myMentions, myTasks, networkForecast] = await Promise.all([
      manifestSlug ? getManifestForPaket(manifestSlug) : Promise.resolve(null),
      getFinanceSummary(),
      bunkingSlug ? getBunkingForPaket(bunkingSlug) : Promise.resolve(null),
      recapSlug ? getPaketWeeklyRecap({ slug: recapSlug }) : Promise.resolve(null),
      getMyMentions({ userEmail: req.user.email, days: 30 })
        .catch((err) => { console.warn('[admin] getMyMentions failed:', err?.message || err); return null; }),
      getMyOpenTasks({ assigneeEmail: req.user.email })
        .catch((err) => { console.warn('[admin] getMyOpenTasks failed:', err?.message || err); return null; }),
      // Stage 100 — cross-agent komisi pipeline. Best-effort.
      getAllAgentsCommissionForecast({ windowDays: 90 })
        .catch((err) => { console.warn('[admin] network forecast failed:', err?.message || err); return null; }),
    ]);
    // Stage 205 — apply pickup filter to a shallow copy so the raw
    // bookings array stays available for the summary panel.
    const manifest = manifestRaw && manifestPickupId
      ? filterManifestByPickup(manifestRaw, manifestPickupId)
      : manifestRaw;
    res.render('admin-dashboard', {
      user: req.user,
      ...overview,
      manifest,
      manifestPickupId,
      finance,
      bunking,
      paketRecap,
      recapSlug,
      myMentions,
      myTasks,
      networkForecast,
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

// Stage 211 — dietary roll-up CSV for the catering / hotel kitchen brief.
// Per-jemaah list of non-REGULAR diets + per-category pax tally footer.
router.get(
  '/manifest/:slug/dietary.csv',
  asyncHandler(async (req, res) => {
    const { buildDietaryRollupCsv } = await import('../services/dietaryRollupCsv.js');
    const out = await buildDietaryRollupCsv(req.params.slug);
    if (!out) return res.status(404).type('text/plain').send('Paket tidak ditemukan');
    const safeSlug = out.paket.slug.replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dietary_${safeSlug}.csv"`);
    res.send(out.csv);
  }),
);

// Stage 208 — pickup roster CSV. ?pickup=<id> narrows to one bus
// route; ?pickup=__TBD__ to show jemaah without a pickup choice yet.
router.get(
  '/manifest/:slug/pickup-roster.csv',
  asyncHandler(async (req, res) => {
    const { buildPickupRosterCsv } = await import('../services/pickupRosterCsv.js');
    const pickupId = (req.query.pickup || '').toString() || null;
    const out = await buildPickupRosterCsv(req.params.slug, { pickupId });
    if (!out) return res.status(404).type('text/plain').send('Paket tidak ditemukan');
    const safeSlug = out.paket.slug.replace(/[^A-Za-z0-9_-]/g, '_');
    const safeSuffix = pickupId
      ? '_' + pickupId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 30)
      : '';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pickup_roster_${safeSlug}${safeSuffix}.csv"`);
    res.send(out.csv);
  }),
);

// Stage 107 — bulk dossier zip. Accepts form-encoded `bookingIds[]` (one
// per checked row in the manifest). Loads each voucher then streams a
// mega-zip with one subfolder per booking. ?format=csv for the accounting
// flow (same per-booking swap as the single bundle).
router.post(
  '/manifest/:slug/bundles.zip',
  asyncHandler(async (req, res) => {
    let ids = req.body?.bookingIds;
    if (!ids) return res.status(400).type('text/plain').send('Pilih minimal satu booking');
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.filter(Boolean).slice(0, 200);  // cap to avoid runaway zip size
    if (ids.length === 0) return res.status(400).type('text/plain').send('Pilih minimal satu booking');

    const { db } = await import('../lib/db.js');
    const paket = await db.paket.findUnique({ where: { slug: req.params.slug }, select: { title: true } });
    if (!paket) return res.status(404).type('text/plain').send('Paket tidak ditemukan');

    const { getAdminBookingVoucher } = await import('../services/bookingVoucher.js');
    const vouchers = [];
    for (const id of ids) {
      try {
        const v = await getAdminBookingVoucher(id);
        vouchers.push(v);
      } catch (err) {
        console.warn(`[bulk-bundle] booking ${id} skipped:`, err?.message || err);
      }
    }
    const { streamBulkBookingBundle } = await import('../services/bookingBundle.js');
    const format = (req.query.format || 'pdf').toString().toLowerCase();
    await streamBulkBookingBundle(
      { vouchers, paketTitle: paket.title },
      res,
      { format: format === 'csv' ? 'csv' : 'pdf' },
    );
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

// Stage 97 — push debug page. OWNER+SUPERADMIN+MANAJER_OPS only.
router.get(
  '/push-debug',
  asyncHandler(async (req, res) => {
    const { listAllPushSubscriptionsForDebug, getPushMode, getPublicKey } = await import('../services/webPush.js');
    const subs = await listAllPushSubscriptionsForDebug();
    res.render('admin-push-debug', {
      user: req.user,
      subs,
      mode: getPushMode(),
      publicKeyConfigured: !!getPublicKey(),
      flash: { test: req.query.test || null, err: req.query.err || null },
    });
  }),
);

router.post(
  '/push-debug/:id/test',
  asyncHandler(async (req, res) => {
    const { sendTestPushToSubscription } = await import('../services/webPush.js');
    const r = await sendTestPushToSubscription(req.params.id);
    res.redirect('/admin/push-debug?test=' + encodeURIComponent(r.status || (r.ok ? 'ok' : 'err')));
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

// Stage 179 — admin team shared note (single-row config).
router.post(
  '/team-note',
  asyncHandler(async (req, res) => {
    const { updateAdminTeamNote } = await import('../services/adminTeamNote.js');
    try {
      await updateAdminTeamNote({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        body: req.body?.body,
      });
      res.redirect('/admin?ok=team_note');
    } catch (err) {
      const msg = err?.message || 'Gagal simpan';
      res.redirect('/admin?err=' + encodeURIComponent(msg));
    }
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

// Stage 144 — no-show queue (paid-but-didn't-board bookings).
// Auto-populated daily by `detect-no-shows` cron; admin uses this to
// follow up on refund / reschedule / debt collection.
router.get(
  '/no-shows',
  asyncHandler(async (req, res) => {
    const { listNoShows } = await import('../services/noShow.js');
    const result = await listNoShows({ page: req.query.page || 1, pageSize: 50 });
    res.render('admin-no-shows', { user: req.user, ...result });
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
