// Web Push subscribe/unsubscribe + public-key surface for admins.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  subscribePush, unsubscribePush, getPublicKey, getPushMode,
} from '../services/webPush.js';

const router = Router();

// All push routes — admin only for now. Crew/jemaah push is a future stage.
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

// GET /api/admin/push/config — public VAPID key + mode (so the client knows
// whether to attempt subscription at all).
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({ publicKey: getPublicKey(), mode: getPushMode() });
  }),
);

router.post(
  '/subscribe',
  asyncHandler(async (req, res) => {
    try {
      const row = await subscribePush({
        userId: req.user.id,
        subscription: req.body?.subscription || req.body,
        userAgent: req.headers['user-agent'] || null,
      });
      res.json({ ok: true, id: row.id });
    } catch (err) {
      if (err.code === 'BAD_SUBSCRIPTION') {
        return res.status(400).json({ error: { code: 'BAD_SUBSCRIPTION', message: err.message } });
      }
      throw err;
    }
  }),
);

router.post(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const endpoint = req.body?.endpoint || null;
    const id = req.body?.id || null;
    const r = await unsubscribePush({ endpoint, id, userId: req.user.id });
    res.json(r);
  }),
);

export default router;
