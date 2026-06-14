// Stage 289 — public inquiry submit (form-encoded from /p/:slug)
// + Stage 290 admin queue + convert-to-lead routes
//
// Two routers exported:
//   - inquiryPublicRouter → mounted on /api (POST /api/inquiry); rate-limited
//   - inquiryAdminRouter  → mounted on /admin/inquiries (list + convert + archive)
//
// Public surface uses form POST + redirect-after-POST so the no-JS
// fallback works (mirrors S5 booking form convention).

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { submitPublicInquiry, listInquiries } from '../services/publicInquiry.js';
import { audit } from '../lib/audit.js';
import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

// ── PUBLIC ROUTER (mounted on /api) ──────────────────────────
export const inquiryPublicRouter = Router();

const inquiryLimiter = rateLimit({ windowMs: 60_000, max: 6, code: 'INQUIRY_RATE_LIMITED' });

inquiryPublicRouter.post(
  '/inquiry',
  inquiryLimiter,
  asyncHandler(async (req, res) => {
    const paketSlug = (req.body?.paketSlug || '').toString();
    try {
      await submitPublicInquiry({ req, input: req.body || {} });
      // Redirect back to the paket page with a success flash. When no
      // paket context, fall back to the landing page.
      const target = paketSlug ? `/p/${encodeURIComponent(paketSlug)}` : '/';
      res.redirect(`${target}?inquiry=sent`);
    } catch (err) {
      const target = paketSlug ? `/p/${encodeURIComponent(paketSlug)}` : '/';
      const msg = err?.message || 'Gagal kirim inquiry';
      res.redirect(`${target}?inquiry=err&msg=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── ADMIN ROUTER (mounted on /admin/inquiries) ───────────────
export const inquiryAdminRouter = Router();

const VIEW_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
const ACT_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

inquiryAdminRouter.use(requireAuth, requireRole(...VIEW_ROLES));

inquiryAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = (req.query.status || '').toString().toUpperCase();
    const page = parseInt(req.query.page, 10) || 1;
    const r = await listInquiries({
      status: ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED'].includes(status) ? status : null,
      page,
    });
    res.render('admin-inquiries', {
      user: req.user, ...r, statusFilter: status || 'ALL',
      ok: req.query.ok || null, err: req.query.err || null,
    });
  }),
);

// Mark as CONTACTED (admin acknowledged — soft tag, not terminal)
inquiryAdminRouter.post(
  '/:id/contact',
  requireRole(...ACT_ROLES),
  asyncHandler(async (req, res) => {
    const before = await db.publicInquiry.findUnique({ where: { id: req.params.id } });
    if (!before) return res.redirect('/admin/inquiries?err=not_found');
    if (before.status !== 'NEW') {
      return res.redirect(`/admin/inquiries?err=already_${before.status.toLowerCase()}`);
    }
    await db.publicInquiry.update({
      where: { id: req.params.id }, data: { status: 'CONTACTED' },
    });
    await audit({
      req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'UPDATE', entity: 'PublicInquiry', entityId: req.params.id,
      before: { status: before.status },
      after: { status: 'CONTACTED' },
    });
    res.redirect('/admin/inquiries?ok=contacted');
  }),
);

// Convert → create a Lead under the chosen agent
inquiryAdminRouter.post(
  '/:id/convert',
  requireRole(...ACT_ROLES),
  asyncHandler(async (req, res) => {
    const inquiry = await db.publicInquiry.findUnique({ where: { id: req.params.id } });
    if (!inquiry) return res.redirect('/admin/inquiries?err=not_found');
    if (inquiry.status === 'CONVERTED') {
      return res.redirect(`/admin/inquiries?err=already_converted`);
    }
    if (inquiry.status === 'ARCHIVED') {
      return res.redirect(`/admin/inquiries?err=archived`);
    }
    const agentSlug = (req.body?.agentSlug || inquiry.agentSlug || '').toString().trim();
    if (!agentSlug) {
      return res.redirect('/admin/inquiries?err=agent_required');
    }
    const agent = await db.agentProfile.findUnique({
      where: { slug: agentSlug },
      select: { id: true, slug: true },
    });
    if (!agent) {
      return res.redirect(`/admin/inquiries?err=${encodeURIComponent('Agen tidak ditemukan: ' + agentSlug)}`);
    }
    try {
      const lead = await db.lead.create({
        data: {
          agentId: agent.id,
          fullName: inquiry.fullName,
          phone: inquiry.phone,
          email: inquiry.email || null,
          notes: inquiry.message ? `[Dari inquiry] ${inquiry.message}` : '[Dari inquiry]',
          source: 'OTHER',
          status: 'COLD',
          interestedPaketSlug: inquiry.paketSlug || null,
        },
      });
      await db.publicInquiry.update({
        where: { id: inquiry.id },
        data: { status: 'CONVERTED', convertedLeadId: lead.id, convertedAt: new Date() },
      });
      await audit({
        req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        action: 'UPDATE', entity: 'PublicInquiry', entityId: inquiry.id,
        before: { status: inquiry.status },
        after: { status: 'CONVERTED', leadId: lead.id, agentSlug },
      });
      res.redirect('/admin/inquiries?ok=converted');
    } catch (err) {
      throw new HttpError(500, err?.message || 'Gagal convert inquiry', 'INQUIRY_CONVERT_FAILED');
    }
  }),
);

// Archive (spam / not interested) — terminal
inquiryAdminRouter.post(
  '/:id/archive',
  requireRole(...ACT_ROLES),
  asyncHandler(async (req, res) => {
    const before = await db.publicInquiry.findUnique({ where: { id: req.params.id } });
    if (!before) return res.redirect('/admin/inquiries?err=not_found');
    if (before.status === 'CONVERTED' || before.status === 'ARCHIVED') {
      return res.redirect(`/admin/inquiries?err=already_${before.status.toLowerCase()}`);
    }
    const reason = (req.body?.reason || '').toString().slice(0, 500);
    await db.publicInquiry.update({
      where: { id: req.params.id },
      data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason || null },
    });
    await audit({
      req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'UPDATE', entity: 'PublicInquiry', entityId: req.params.id,
      before: { status: before.status },
      after: { status: 'ARCHIVED', reason: reason || null },
    });
    res.redirect('/admin/inquiries?ok=archived');
  }),
);

export default inquiryAdminRouter;
