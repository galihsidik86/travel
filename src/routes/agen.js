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
  listMyNotifications, countUnreadForUser, markAllReadForUser,
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
    const [data, commissionForecast, unreadCount, statements] = await Promise.all([
      getAgentDashboard(profile.id, range),
      getAgentCommissionForecast({ agentId: profile.id, windowDays: 90 })
        .catch((err) => { console.warn('[agen] forecast failed:', err?.message || err); return null; }),
      // Stage 148 — unread badge on the agen topbar
      countUnreadForUser(req.user.id)
        .catch(() => 0),
      // Stage 150 — last 24 months of komisi statements for the wallet tab
      listAgentStatements({ agentId: profile.id })
        .catch((err) => { console.warn('[agen] statements failed:', err?.message || err); return []; }),
    ]);
    res.render('agen-crm', {
      user: req.user, ...data, range, activeTab, commissionForecast,
      unreadCount, statements,
    });
  }),
);

// Stage 148 — agent inbox. Mirrors /saya/notifications behaviour: list,
// then mark-all-read in a single render so the badge clears next paint.
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const notifications = await listMyNotifications(req.user.id);
    await markAllReadForUser(req.user.id);
    res.render('agen-notifications', { user: req.user, notifications });
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
      select: { id: true, slug: true, displayName: true, notifKomisiStatement: true },
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
