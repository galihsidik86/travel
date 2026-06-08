import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { optionalAuth } from '../middleware/auth.js';
import { env } from '../env.js';
import { db } from '../lib/db.js';
import { getPaketBySlug, getAgentBySlug } from '../services/paket.js';
import { getOrSetVisitorId, recordPaketView } from '../services/paketView.js';

export const paketHtmlRouter = Router();
export const paketJsonRouter = Router();

// HTML: /p/:slug?a=<agentSlug>
paketHtmlRouter.get(
  '/:slug',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const paket = await getPaketBySlug(req.params.slug);
    if (!paket) return res.status(404).render('error', { code: 404, message: 'Paket tidak ditemukan' });

    const agent = await getAgentBySlug(req.query.a);

    // Pre-fill data for logged-in JEMAAH (self-booking flow, 5t).
    let prefillJemaah = null;
    if (req.user?.role === 'JEMAAH') {
      const profile = await db.jemaahProfile.findFirst({
        where: { userId: req.user.id },
        select: { fullName: true, phone: true },
      });
      prefillJemaah = profile ? { fullName: profile.fullName, phone: profile.phone } : null;
    }

    // Stage 48 — record the visit. Fire-and-forget — analytics never
    // gate page render. Logged-in admin/agen visits also count (the
    // signal is "someone landed on this page", role-agnostic).
    try {
      const visitorId = getOrSetVisitorId(req, res, { cookieSecure: env.COOKIE_SECURE });
      // Don't await — page render shouldn't block on the DB write
      recordPaketView({
        paketId: paket.id,
        visitorId,
        agentSlug: req.query.a || null,
      });
    } catch (err) {
      console.warn('[paket-landing] view-track failed:', err?.message || err);
    }

    res.render('paket', { paket, agent, currentUser: req.user || null, prefillJemaah });
  }),
);

// JSON: /api/paket/:slug
paketJsonRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const paket = await getPaketBySlug(req.params.slug);
    if (!paket) return res.status(404).json({ error: { message: 'Paket tidak ditemukan', code: 'PAKET_NOT_FOUND' } });

    const agent = req.query.a ? await getAgentBySlug(req.query.a) : null;
    res.json({ paket, agent });
  }),
);
