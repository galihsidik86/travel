// Stage 77 — /r/<token> redirect handler.
// Verifies the HMAC token, upserts an EmailClick row (idempotent on
// (notifId, targetUrl) so repeat clicks bump `clickCount`), then 302s
// to the target. CSRF-exempt (no state-changing form post).
//
// Failure modes:
//   - bad token / unknown notif → 404 "Link tidak valid"
//   - same target URL clicked N times → single row, count incremented
//
// Open-redirect protection: only paths starting with `/` OR `http(s)://`
// pass through `unwrapToken`. Other schemes never make it into the
// token in the first place (see lib/emailClickToken.js wrapUrl).

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { db } from '../lib/db.js';
import { unwrapToken } from '../lib/emailClickToken.js';

const router = Router();

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const decoded = unwrapToken(req.params.token);
    if (!decoded) return res.status(404).type('text/plain').send('Link tidak valid');

    const { notifId, url } = decoded;
    // Defense in depth: re-check the URL shape
    if (!url || (!/^https?:\/\//.test(url) && !url.startsWith('/'))) {
      return res.status(404).type('text/plain').send('Link tidak valid');
    }

    // Verify the notif row exists (token may signature-match but point at
    // a deleted notif — don't track + don't redirect to potentially
    // stale URL).
    const notif = await db.notification.findUnique({
      where: { id: notifId },
      select: { id: true },
    });
    if (!notif) return res.status(404).type('text/plain').send('Notif tidak ditemukan');

    // Upsert click row. Idempotent on (notifId, url). Best-effort —
    // any DB hiccup must not block the redirect itself.
    try {
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 45);
      const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
      await db.emailClick.upsert({
        where: {
          notificationId_targetUrl: { notificationId: notifId, targetUrl: url.slice(0, 500) },
        },
        create: {
          notificationId: notifId,
          targetUrl: url.slice(0, 500),
          ipAddress: ip || null,
          userAgent: ua || null,
        },
        update: {
          lastClickAt: new Date(),
          clickCount: { increment: 1 },
        },
      });
    } catch (err) {
      console.warn('[email-click] upsert failed:', err?.message || err);
    }

    res.redirect(302, url);
  }),
);

export default router;
