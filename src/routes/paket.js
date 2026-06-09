import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { optionalAuth } from '../middleware/auth.js';
import { env } from '../env.js';
import { db } from '../lib/db.js';
import { getPaketBySlug, getAgentBySlug } from '../services/paket.js';
import { getOrSetVisitorId, recordPaketView, pickHeroVariant, parseReferrerHost } from '../services/paketView.js';
import { getPublishedTestimonialsForPaket } from '../services/testimonialAdmin.js';

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
    // Stage 56 — `res.on('finish')` captures the full response duration
    // (including res.render which is the heavy part), then writes the
    // visit row with `renderMs`. The DB write is post-response so it
    // never adds latency to the user-facing render.
    let heroVariant = 'A';
    let visitorId = null;
    try {
      visitorId = getOrSetVisitorId(req, res, { cookieSecure: env.COOKIE_SECURE });
      // Resolve variant only if the paket has variant B configured
      heroVariant = paket.heroTitleHtmlVariantB ? pickHeroVariant(visitorId) : 'A';
    } catch (err) {
      console.warn('[paket-landing] visitor-cookie resolve failed:', err?.message || err);
    }
    const startMs = Date.now();
    res.on('finish', () => {
      if (!visitorId) return;
      const renderMs = Date.now() - startMs;
      const utm = {
        source:   req.query.utm_source   ? String(req.query.utm_source).slice(0, 80)   : null,
        medium:   req.query.utm_medium   ? String(req.query.utm_medium).slice(0, 80)   : null,
        campaign: req.query.utm_campaign ? String(req.query.utm_campaign).slice(0, 120) : null,
      };
      // Stage 132 — parse Referer header into a host bucket so visits
      // without UTM still carry attribution. Same-origin nav (in-site
      // refresh) is dropped — caller knows where the user came from
      // within the site already.
      const ownHost = req.get('x-forwarded-host') || req.get('host');
      const referrerHost = parseReferrerHost(req.get('referer'), ownHost);
      // Don't await — the response is already sent; this just persists.
      recordPaketView({
        paketId: paket.id,
        visitorId,
        agentSlug: req.query.a || null,
        heroVariant: paket.heroTitleHtmlVariantB ? heroVariant : null,
        utm,
        referrerHost,
        renderMs,
      });
    });

    // Stage 52 — pick CTA text per variant. Reuses the same heroVariant
    // bucketing so admins running both A/B tests at once see correlated
    // signals (variant B converts better because of hero OR CTA — but at
    // least both surfaces are in lock-step per visitor).
    const DEFAULT_CTA = 'BOOK SEKARANG';
    let ctaText = DEFAULT_CTA;
    if (heroVariant === 'B' && paket.ctaTextVariantB) ctaText = paket.ctaTextVariantB;
    else if (heroVariant === 'A' && paket.ctaTextVariantA) ctaText = paket.ctaTextVariantA;

    // Stage 63 — load PUBLISHED testimonials (paket-specific OR generic).
    // Best-effort: failure shouldn't break the landing page.
    let testimonials = [];
    try {
      testimonials = await getPublishedTestimonialsForPaket(paket.id);
    } catch (err) {
      console.warn('[paket-landing] testimonials load failed:', err?.message || err);
    }

    // Stage 71 — pull assigned crew with public profiles. Skipped silently
    // if no crew or none have a `slug` (crew opt-out by leaving slug null).
    let publicCrew = [];
    try {
      publicCrew = await db.user.findMany({
        where: {
          role: 'MUTHAWWIF',
          status: 'ACTIVE',
          deletedAt: null,
          crewAssignments: { some: { paketId: paket.id } },
          crew: { slug: { not: null } },
        },
        select: {
          fullName: true,
          crew: { select: { slug: true, titlePrefix: true, photoUrl: true } },
        },
      });
    } catch (err) {
      console.warn('[paket-landing] public crew lookup failed:', err?.message || err);
    }

    res.render('paket', {
      paket, agent, currentUser: req.user || null, prefillJemaah,
      heroVariant, ctaText, testimonials, publicCrew,
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
