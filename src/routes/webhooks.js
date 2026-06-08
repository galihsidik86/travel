// Stage 108 — admin CRUD for outbound webhooks. OWNER+SUPERADMIN only —
// these subscriptions push business events to third parties, so the gate
// matches the user-management gate (mirrors `/admin/users`).
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listWebhooks, createWebhook, updateWebhookStatus, deleteWebhook, testFireWebhook,
  rotateWebhookSecret, EVENT_NAMES,
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
      flash: {
        ok: req.query.ok || null,
        err: req.query.err || null,
        // S118 — surface the newly rotated secret ONCE
        rotatedSecret: req.query.rotatedSecret || null,
        rotatedFor: req.query.rotatedFor || null,
        graceUntil: req.query.graceUntil || null,
      },
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

// Stage 118 — rotate the webhook signing secret. Returns the new secret
// once via the same flash-via-query pattern as API key creation. Old
// secret stays valid for `graceHours` (default 24, capped 1..168).
router.post(
  '/:id/rotate-secret',
  asyncHandler(async (req, res) => {
    try {
      const result = await rotateWebhookSecret({
        req, actor: actorFrom(req),
        id: req.params.id,
        graceHours: req.body?.graceHours,
      });
      const u = new URL('/admin/webhooks', 'http://x');
      u.searchParams.set('rotatedSecret', result.newSecret);
      u.searchParams.set('rotatedFor', req.params.id);
      u.searchParams.set('graceUntil', result.prevSecretExpiresAt.toISOString());
      res.redirect(u.pathname + u.search);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/webhooks?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

// Stage 117 — admin test-fire. POSTs a synthetic signed event to the
// webhook URL and renders the HTTP response inline. Doesn't insert a
// WebhookDelivery row — manual probe, kept out of the diagnostic surfaces.
router.post(
  '/:id/test-fire',
  asyncHandler(async (req, res) => {
    const { db } = await import('../lib/db.js');
    const webhook = await db.webhook.findUnique({ where: { id: req.params.id } });
    if (!webhook) return res.status(404).type('text/plain').send('Webhook tidak ditemukan');
    const eventName = (req.body?.event || 'test.ping').toString();
    const result = await testFireWebhook({ webhook, eventName });
    res.render('admin-webhook-test-result', { user: req.user, webhook, eventName, result });
  }),
);

// Stage 109 — per-webhook delivery list (last 100). Lets admin see the
// retry queue + diagnose stuck rows.
router.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const { db } = await import('../lib/db.js');
    const webhook = await db.webhook.findUnique({ where: { id: req.params.id } });
    if (!webhook) return res.status(404).type('text/plain').send('Webhook tidak ditemukan');
    const deliveries = await db.webhookDelivery.findMany({
      where: { webhookId: webhook.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, eventName: true, status: true, attemptCount: true,
        lastStatusCode: true, lastError: true, lastAttemptAt: true, nextRetryAt: true,
        createdAt: true,
      },
    });
    res.render('admin-webhook-deliveries', { user: req.user, webhook, deliveries });
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
