import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { db } from '../lib/db.js';
import { getAgentDashboard } from '../services/agenCrm.js';
import { HttpError } from '../middleware/error.js';
// Stage 148 — reuse the role-agnostic recipientUserId-scoped helpers
// from jemaahPortal for the agen/crew inbox. Function names are slightly
// jemaah-flavored but the queries are pure recipientUserId filters.
import {
  listMyNotifications, countUnreadForUser, markAllReadForUser,
} from '../services/jemaahPortal.js';

const router = Router();

router.use(requireAuth, requireRole('AGEN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
    });
    if (!profile) {
      throw new HttpError(404, 'Profil agen belum dibuat untuk akun ini', 'AGENT_PROFILE_MISSING');
    }
    const range = { from: req.query.from || '', to: req.query.to || '' };
    const activeTab = req.query.tab || 'leads';
    const { getAgentCommissionForecast } = await import('../services/agentForecast.js');
    const [data, commissionForecast, unreadCount] = await Promise.all([
      getAgentDashboard(profile.id, range),
      getAgentCommissionForecast({ agentId: profile.id, windowDays: 90 })
        .catch((err) => { console.warn('[agen] forecast failed:', err?.message || err); return null; }),
      // Stage 148 — unread badge on the agen topbar
      countUnreadForUser(req.user.id)
        .catch(() => 0),
    ]);
    res.render('agen-crm', {
      user: req.user, ...data, range, activeTab, commissionForecast,
      unreadCount,
    });
  }),
);

// Stage 148 — agent inbox. Mirrors /saya/notifications behaviour: list,
// then mark-all-read in a single render so the badge clears next paint.
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const notifications = await listMyNotifications(req.user.id);
    await markAllReadForUser(req.user.id);
    res.render('agen-notifications', { user: req.user, notifications });
  }),
);

export default router;
