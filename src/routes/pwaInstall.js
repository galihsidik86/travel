// Stage 360 — public endpoint that accepts install funnel events from
// shared/pwa.js. Anonymous-friendly (most events fire on public landing
// pages before login); uses optionalAuth so we can still attribute when
// the visitor is logged in. Best-effort posture — telemetry must never
// break the client; we always 204 even on validation failure to keep
// the client-side fetch quiet.

import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { optionalAuth } from '../middleware/auth.js';
import { recordInstallEvent } from '../services/pwaInstallFunnel.js';

const router = express.Router();

router.post(
  '/install-event',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { event, kind } = req.body || {};
    const userAgent = req.get('user-agent') || '';
    const role = req.user?.role || null;
    const actorId = req.user?.id || null;
    const actorEmail = req.user?.email || null;
    await recordInstallEvent({ event, userAgent, role, kind, actorId, actorEmail });
    // Always 204 — client doesn't need to handle errors for fire-and-forget telemetry
    res.status(204).end();
  }),
);

export default router;
