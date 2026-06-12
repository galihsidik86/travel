import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { dispatchNotification, bulkRetryFailedNotifications } from '../services/notifications.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

const TYPES = ['BOOKING_CREATED', 'PAYMENT_RECEIVED', 'BOOKING_LUNAS', 'PAYOUT_CREATED', 'DOC_VERIFIED', 'GENERIC'];
const STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'];
const CHANNELS = ['EMAIL', 'WA', 'CONSOLE'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'ALL';
    const channel = req.query.channel || 'ALL';
    const type = req.query.type || 'ALL';

    const where = {};
    if (status !== 'ALL') where.status = status;
    if (channel !== 'ALL') where.channel = channel;
    if (type !== 'ALL') where.type = type;

    const rows = await db.notification.findMany({
      where, take: 200,
      orderBy: { createdAt: 'desc' },
    });
    res.render('notifications-list', {
      user: req.user, rows,
      filters: { status, channel, type },
      META: { TYPES, STATUSES, CHANNELS },
    });
  }),
);

// Per-row "Send now" — dispatch one notification, bypass queue.
// 5nn: admin-triggered retry resets the attempt budget. If a FAILED row has
// already exhausted automatic retries, the operator clicking "Send now"
// signals "I want a fresh shot at this", so we zero out attemptCount and
// clear backoff state before dispatching. The dispatch itself then re-stamps
// attemptCount/lastAttemptAt with the result.
router.post(
  '/:id/send',
  asyncHandler(async (req, res) => {
    const n = await db.notification.findUnique({ where: { id: req.params.id } });
    if (!n) throw new HttpError(404, 'Notif tidak ditemukan', 'NOTIF_NOT_FOUND');
    if (n.status !== 'PENDING' && n.status !== 'FAILED') {
      return res.redirect(`/admin/notifications?err=${encodeURIComponent('Hanya PENDING/FAILED yang bisa dispatch ulang')}`);
    }
    const reset = await db.notification.update({
      where: { id: n.id },
      data: { status: 'PENDING', attemptCount: 0, nextRetryAt: null, error: null },
    });
    await dispatchNotification(reset);
    res.redirect('/admin/notifications?ok=sent');
  }),
);

// Stage 225 — bulk retry. Admin selects multiple FAILED rows on the
// notif queue page and POSTs the ids array. Each row gets reset
// (attemptCount=0 + nextRetryAt=null) then re-dispatched. Per-row
// failure caught so a bad row doesn't abort the batch. Capped at 200
// per request to avoid runaway. Skips PENDING (worker handles it) and
// SENT/SKIPPED (terminal — retry is meaningless).
router.post(
  '/bulk-retry',
  asyncHandler(async (req, res) => {
    let ids = req.body?.notifIds;
    if (!ids) {
      return res.redirect('/admin/notifications?err=' + encodeURIComponent('Pilih minimal satu notif'));
    }
    if (!Array.isArray(ids)) ids = [ids];
    const r = await bulkRetryFailedNotifications({ ids });
    if (r.requested === 0) {
      return res.redirect('/admin/notifications?err=' + encodeURIComponent('Pilih minimal satu notif'));
    }
    const summary = `retry ${r.retried}; skipped ${r.skipped}; gagal ${r.failed}`;
    res.redirect('/admin/notifications?ok=' + encodeURIComponent(summary));
  }),
);

export default router;
