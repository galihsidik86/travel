// Stage 74 — public agent profile route. Mounted at /a.
// Stage 76 — also exports a leaderboard router for /agen-leaderboard.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getAgentPublicProfile } from '../services/agentPublic.js';
import { getAgentLeaderboardPublic } from '../services/agentLeaderboardPublic.js';

const router = Router();

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const agent = await getAgentPublicProfile(req.params.slug);
    if (!agent) return res.status(404).render('error', { code: 404, message: 'Agen tidak ditemukan' });
    res.render('agent-public', { agent });
  }),
);

export default router;

// Stage 76 — public leaderboard router mounted at /agen-leaderboard
export const agentLeaderboardRouter = Router();
agentLeaderboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await getAgentLeaderboardPublic({ limit: 10 });
    res.render('agent-leaderboard-public', { rows });
  }),
);
