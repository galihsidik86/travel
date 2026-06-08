import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { optionalAuth } from '../middleware/auth.js';
import { env } from '../env.js';
import { db } from '../lib/db.js';
import { getPaketBySlug, getAgentBySlug } from '../services/paket.js';
import { getOrSetVisitorId, recordPaketView, pickHeroVariant } from '../services/paketView.js';

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

    // Stage 48/50/51 — record the visit. Fire-and-forget. Hero variant
    // resolution (S50) is deterministic per visitor cookie so refreshes
    // are stable. UTM tags (S51) captured from query, first-touch wins
    // (upsert leaves the create-row tags intact on later visits).
    let heroVariant = 'A';
    try {
      const visitorId = getOrSetVisitorId(req, res, { cookieSecure: env.COOKIE_SECURE });
      // Resolve variant only if the paket has variant B configured
      heroVariant = paket.heroTitleHtmlVariantB ? pickHeroVariant(visitorId) : 'A';
      const utm = {
        source:   req.query.utm_source   ? String(req.query.utm_source).slice(0, 80)   : null,
        medium:   req.query.utm_medium   ? String(req.query.utm_medium).slice(0, 80)   : null,
        campaign: req.query.utm_campaign ? String(req.query.utm_campaign).slice(0, 120) : null,
      };
      // Don't await — page render shouldn't block on the DB write
      recordPaketView({
        paketId: paket.id,
        visitorId,
        agentSlug: req.query.a || null,
        heroVariant: paket.heroTitleHtmlVariantB ? heroVariant : null,
        utm,
      });
    } catch (err) {
      console.warn('[paket-landing] view-track failed:', err?.message || err);
    }

    res.render('paket', {
      paket, agent, currentUser: req.user || null, prefillJemaah,
      heroVariant,
    });
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
