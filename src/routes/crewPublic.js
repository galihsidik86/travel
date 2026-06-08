// Stage 71 — public crew profile route. Mounted at /c.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getCrewPublicProfile } from '../services/crewPublic.js';

const router = Router();

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const crew = await getCrewPublicProfile(req.params.slug);
    if (!crew) return res.status(404).render('error', { code: 404, message: 'Crew tidak ditemukan' });
    res.render('crew-public', { crew });
  }),
);

export default router;
