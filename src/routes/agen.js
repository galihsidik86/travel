import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { db } from '../lib/db.js';
import { getAgentDashboard } from '../services/agenCrm.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  requireRole('AGEN'),
  asyncHandler(async (req, res) => {
    const profile = await db.agentProfile.findUnique({
      where: { userId: req.user.id },
    });
    if (!profile) {
      throw new HttpError(404, 'Profil agen belum dibuat untuk akun ini', 'AGENT_PROFILE_MISSING');
    }
    const range = { from: req.query.from || '', to: req.query.to || '' };
    const activeTab = req.query.tab || 'leads';
    const data = await getAgentDashboard(profile.id, range);
    res.render('agen-crm', { user: req.user, ...data, range, activeTab });
  }),
);

export default router;
