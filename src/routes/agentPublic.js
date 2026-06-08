// Stage 74 — public agent profile route. Mounted at /a.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getAgentPublicProfile } from '../services/agentPublic.js';

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
