// Stage 108 — admin CRUD for outbound webhooks. OWNER+SUPERADMIN only —
// these subscriptions push business events to third parties, so the gate
// matches the user-management gate (mirrors `/admin/users`).
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listWebhooks, createWebhook, updateWebhookStatus, deleteWebhook, EVENT_NAMES,
} from '../services/webhooks.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const webhooks = await listWebhooks();
    res.render('admin-webhooks', {
      user: req.user, webhooks, eventNames: EVENT_NAMES,
      flash: { ok: req.query.ok || null, err: req.query.err || null },
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      // Events come in as either an array (multiple checkboxes) or a
      // single string when only one was checked. Normalize.
      let events = req.body?.events;
      if (typeof events === 'string') events = [events];
      events = events || [];
      await createWebhook({
        req, actor: actorFrom(req),
        url: req.body?.url,
        events,
        description: req.body?.description,
      });
      res.redirect('/admin/webhooks?ok=created');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/webhooks?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    try {
      await updateWebhookStatus({
        req, actor: actorFrom(req),
        id: req.params.id, status: req.body?.status,
      });
      res.redirect('/admin/webhooks?ok=status');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/webhooks?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    try {
      await deleteWebhook({ req, actor: actorFrom(req), id: req.params.id });
      res.redirect('/admin/webhooks?ok=deleted');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/webhooks?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

export default router;
