// Stage 111 — public inbound webhook receiver + admin viewer.
import express, { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  receiveInbound, listInbound, replayInbound, canReplayInbound,
  VERIFIERS, HANDLERS, KNOWN_SOURCES,
} from '../services/inboundWebhooks.js';

const router = Router();

// Lowercase header map helper — verifier expects lowercase keys.
function lowercaseHeaders(req) {
  const out = {};
  for (const k of Object.keys(req.headers)) out[k.toLowerCase()] = req.headers[k];
  return out;
}

// ── Public receiver: POST /api/webhook-in/:source ───────────
// No auth; signature verification per source. CSRF middleware excludes
// `/api/webhook-in/` (see csrf.js skip list). Body is captured raw via
// `express.text({type: '*/*'})` so signature verifiers can hash the
// exact bytes the partner POSTed.
router.post(
  '/:source',
  express.text({ type: '*/*', limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const source = req.params.source.toString().toLowerCase().slice(0, 80);
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const result = await receiveInbound({
      source, rawBody,
      headers: lowercaseHeaders(req),
    });
    if (result.status === 'REJECTED') {
      return res.status(401).json({ ok: false, reason: 'bad_signature', id: result.id });
    }
    res.json({ ok: true, id: result.id, status: result.status });
  }),
);

// ── Admin viewer: /admin/inbound-webhooks ───────────────────
// OWNER+SUPERADMIN+MANAJER_OPS — diagnostic surface for partner integrations.
const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

adminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      source: (req.query.source || '').toString() || null,
      status: (req.query.status || '').toString() || null,
    };
    const baseRows = await listInbound({ source: filters.source, status: filters.status });
    // S130 — annotate each row with whether replay is actually allowed
    // so the view can hide / disable the button per-row rather than
    // always showing it and surprising the admin with refusals.
    const rows = baseRows.map((r) => ({
      ...r,
      replayGate: canReplayInbound({ status: r.status, source: r.source }),
    }));
    res.render('admin-inbound-webhooks', {
      user: req.user, rows, filters,
      knownSources: [...KNOWN_SOURCES],
      flash: { replay: req.query.replay || null, err: req.query.err || null },
    });
  }),
);

adminRouter.post(
  '/:id/replay',
  asyncHandler(async (req, res) => {
    const r = await replayInbound(req.params.id);
    const q = r.ok ? 'ok' : encodeURIComponent(r.reason || 'unknown');
    res.redirect('/admin/inbound-webhooks?replay=' + q);
  }),
);

export default router;
export { adminRouter as inboundWebhooksAdminRouter };
