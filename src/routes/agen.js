import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { db } from '../lib/db.js';
import { getAgentDashboard } from '../services/agenCrm.js';
import { HttpError } from '../middleware/error.js';
// Stage 148 — reuse the role-agnostic recipientUserId-scoped helpers
// from jemaahPortal for the agen/crew inbox. Function names are slightly
// jemaah-flavored but the queries are pure recipientUserId filters.
import {
  listMyNotifications, listMyNotificationsPaginated,
  countUnreadForUser, markAllReadForUser,
} from '../services/jemaahPortal.js';

const router = Router();

router.use(requireAuth, requireRole('AGEN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
    });
    if (!profile) {
      throw new HttpError(404, 'Profil agen belum dibuat untuk akun ini', 'AGENT_PROFILE_MISSING');
    }
    const range = { from: req.query.from || '', to: req.query.to || '' };
    const activeTab = req.query.tab || 'leads';
    const { getAgentCommissionForecast } = await import('../services/agentForecast.js');
    const { listAgentStatements } = await import('../services/komisiStatement.js');
    const [data, commissionForecast, unreadCount, statements, dietaryView, tagRollup, todayLeads, cancelRefundReasons] = await Promise.all([
      getAgentDashboard(profile.id, range),
      getAgentCommissionForecast({ agentId: profile.id, windowDays: 90 })
        .catch((err) => { console.warn('[agen] forecast failed:', err?.message || err); return null; }),
      // Stage 148 — unread badge on the agen topbar
      countUnreadForUser(req.user.id)
        .catch(() => 0),
      // Stage 150 — last 24 months of komisi statements for the wallet tab
      listAgentStatements({ agentId: profile.id })
        .catch((err) => { console.warn('[agen] statements failed:', err?.message || err); return []; }),
      // Stage 241 — dietary view for agen's soon-departing paket (14d window)
      (async () => {
        try {
          const { getAgentDietaryView } = await import('../services/agentDietaryView.js');
          return await getAgentDietaryView({ agentId: profile.id });
        } catch (err) {
          console.warn('[agen] dietary view failed:', err?.message || err);
          return null;
        }
      })(),
      // Stage 242 — booking tag rollup for the agen (VIP/LANSIA/etc.)
      (async () => {
        try {
          const { getAgentTagRollup } = await import('../services/agentTagRollup.js');
          return await getAgentTagRollup({ agentId: profile.id });
        } catch (err) {
          console.warn('[agen] tag rollup failed:', err?.message || err);
          return null;
        }
      })(),
      // Stage 267 — overdue + due-today follow-ups widget
      (async () => {
        try {
          const { getAgentTodayLeads } = await import('../services/agentTodayLeads.js');
          return await getAgentTodayLeads({ agentId: profile.id });
        } catch (err) {
          console.warn('[agen] today leads failed:', err?.message || err);
          return null;
        }
      })(),
      // Stage 304/305 — per-agent cancel + refund reason breakdown
      (async () => {
        try {
          const { getAgentCancelRefundReasons } = await import('../services/agentCancelRefundReasons.js');
          return await getAgentCancelRefundReasons({ agentId: profile.id });
        } catch (err) {
          console.warn('[agen] cancel/refund reasons failed:', err?.message || err);
          return null;
        }
      })(),
    ]);
    res.render('agen-crm', {
      user: req.user, ...data, range, activeTab, commissionForecast,
      unreadCount, statements, dietaryView, tagRollup, todayLeads,
      cancelRefundReasons,
    });
  }),
);

// Stage 148 — agent inbox. Mirrors /saya/notifications behaviour: list,
// then mark-all-read in a single render so the badge clears next paint.
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    // Stage 181 — paginated full history. Default 50/page; ?page=N walks
    // older entries. mark-all-read still happens on every visit so the
    // unread badge clears regardless of which page is being viewed.
    const page = parseInt(req.query.page, 10) || 1;
    const { rows: notifications, total, pagination } =
      await listMyNotificationsPaginated(req.user.id, { page });
    await markAllReadForUser(req.user.id);
    res.render('agen-notifications', {
      user: req.user, notifications, total, pagination,
    });
  }),
);

// Stage 157 — agen profile + notification preferences. Mirrors the
// jemaah-side /saya/profile pattern. Currently only one preference
// (statement email opt-out) but the page is the natural place to add
// more agent-level toggles.
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        id: true, slug: true, displayName: true, notifKomisiStatement: true,
        // S166 — payout banking details for self-service edit
        preferredPayoutMethod: true, bankName: true,
        bankAccountNumber: true, bankAccountName: true,
      },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    res.render('agen-profile', {
      user: req.user, profile,
      flash: { ok: req.query.ok || null },
    });
  }),
);

router.post(
  '/profile/prefs',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    // Unchecked HTML checkbox is absent from req.body — normalise to
    // explicit false (mirrors S5jj). For form POSTs only; JSON
    // callers can pass the boolean directly.
    const notifKomisiStatement = !!req.body?.notifKomisiStatement;
    await db.agentProfile.update({
      where: { id: profile.id },
      data: { notifKomisiStatement },
    });
    res.redirect('/agen/profile?ok=prefs_saved');
  }),
);

// Stage 166 — agent self-service payout banking details. Separate
// endpoint from /prefs so a save here doesn't accidentally flip
// notification preferences (different concerns, different forms).
router.post(
  '/profile/payout-details',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const { updateAgentPayoutDetails } = await import('../services/agentPayoutDetails.js');
    try {
      await updateAgentPayoutDetails({
        req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        agentId: profile.id, input: req.body || {},
      });
      res.redirect('/agen/profile?ok=payout_saved');
    } catch (err) {
      // Validation errors land back on the profile page via querystring
      const msg = err instanceof HttpError ? err.message : (err?.message || 'Gagal menyimpan');
      res.redirect('/agen/profile?ok=payout_err&msg=' + encodeURIComponent(msg));
    }
  }),
);

// Stage 164 — full paginated statement history. /agen Wallet tab
// caps at 24 months for speed; this page lets the agent walk back
// to the very first statement they ever earned.
router.get(
  '/statements',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, slug: true, displayName: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const { listAgentStatementsPaginated } = await import('../services/komisiStatement.js');
    const page = parseInt(req.query.page, 10) || 1;
    const data = await listAgentStatementsPaginated({ agentId: profile.id, page });
    res.render('agen-statements', {
      user: req.user, profile, ...data,
    });
  }),
);

// Stage 170 — payout history CSV. One row per KomisiPayout, with
// amount + method + reference + komisi count. Lets the agent
// reconcile bank-statement deposits against payouts received.
router.get(
  '/payout-history.csv',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, slug: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const { buildAgentPayoutHistoryCsv } = await import('../services/komisiStatement.js');
    const { csv } = await buildAgentPayoutHistoryCsv({ agentId: profile.id });
    const safeSlug = profile.slug.replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payout_history_${safeSlug}.csv"`);
    res.end(csv);
  }),
);

// Stage 168 — lifetime komisi CSV export. Distinct from S165
// (per-period statement CSV) — this covers EVERY Komisi row across
// the agent's history for personal accounting / tax prep.
router.get(
  '/komisi-lifetime.csv',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true, slug: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const { buildAgentLifetimeKomisiCsv } = await import('../services/komisiStatement.js');
    const { csv } = await buildAgentLifetimeKomisiCsv({ agentId: profile.id });
    const safeSlug = profile.slug.replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="komisi_lifetime_${safeSlug}.csv"`);
    res.end(csv);
  }),
);

// Stage 165 — CSV export of a single statement period. Same ownership
// gate as the PDF route + same fire-and-forget counter bump on finish.
router.get(
  '/statements/:id.csv',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const stmt = await db.komisiStatement.findFirst({
      where: { id: req.params.id, agentId: profile.id },
      select: { id: true, periodYM: true, agentId: true },
    });
    if (!stmt) throw new HttpError(404, 'Statement tidak ditemukan', 'STATEMENT_NOT_FOUND');
    const { buildStatementCsv } = await import('../services/komisiStatement.js');
    const { csv } = await buildStatementCsv({ agentId: stmt.agentId, periodYM: stmt.periodYM });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="komisi_${stmt.periodYM}.csv"`);
    // S165: count CSV downloads against the same agent surface counter
    // — opening the CSV is just as much "agent saw the content" as the
    // PDF would be.
    res.on('finish', async () => {
      const { recordStatementDownload } = await import('../services/komisiStatement.js');
      recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
    });
    res.end(csv);
  }),
);

// Stage 150 — download a monthly komisi statement PDF. Ownership
// enforced via the statement's agentId → agentProfile.userId chain;
// cross-agent access 404s (mirrors S20 voucher access pattern).
router.get(
  '/statements/:id.pdf',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!profile) throw new HttpError(404, 'Profil agen tidak ditemukan', 'AGENT_PROFILE_MISSING');
    const stmt = await db.komisiStatement.findFirst({
      where: { id: req.params.id, agentId: profile.id },
      select: { id: true, pdfPath: true, periodYM: true },
    });
    if (!stmt || !stmt.pdfPath) throw new HttpError(404, 'Statement tidak ditemukan', 'STATEMENT_NOT_FOUND');
    // Stream from disk (best-effort — file may have been pruned)
    const { promises: fsp, createReadStream } = await import('node:fs');
    try {
      await fsp.access(stmt.pdfPath);
    } catch {
      throw new HttpError(404, 'File PDF tidak ada di disk — silakan minta admin regenerate', 'PDF_MISSING');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="komisi_${stmt.periodYM}.pdf"`);
    // Stage 162 — fire-and-forget counter bump. AFTER the response
    // headers are written so the user-facing latency isn't affected.
    res.on('finish', async () => {
      const { recordStatementDownload } = await import('../services/komisiStatement.js');
      recordStatementDownload({ statementId: stmt.id, surface: 'agent' });
    });
    createReadStream(stmt.pdfPath).pipe(res);
  }),
);

export default router;
