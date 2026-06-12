// Stage 240 — admin queue for jemaah-submitted right-to-be-forgotten
// requests. OWNER + SUPERADMIN only (privacy compliance sits at the
// top tier — MANAJER_OPS doesn't handle UU PDP decisions).
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listPendingDataDeletionRequests,
  decideDataDeletionRequest,
} from '../services/dataDeletionRequest.js';
import { db } from '../lib/db.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const pending = await listPendingDataDeletionRequests();
    const recentDecisions = await db.dataDeletionRequest.findMany({
      where: { status: { in: ['APPROVED', 'DECLINED'] } },
      orderBy: { decidedAt: 'desc' },
      take: 20,
      include: { user: { select: { email: true, fullName: true, role: true, deletedAt: true } } },
    });
    res.render('data-deletion-requests', {
      user: req.user, pending, recentDecisions, query: req.query,
    });
  }),
);

router.post(
  '/:id/decide',
  asyncHandler(async (req, res) => {
    try {
      const decision = (req.body?.decision || '').toString();
      const decisionReason = (req.body?.decisionReason || '').toString();
      await decideDataDeletionRequest({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        requestId: req.params.id,
        decision,
        decisionReason,
      });
      res.redirect('/admin/data-deletion-requests?ok=' + encodeURIComponent(decision.toLowerCase()));
    } catch (err) {
      const msg = err?.message || 'Gagal proses keputusan';
      res.redirect('/admin/data-deletion-requests?err=' + encodeURIComponent(msg));
    }
  }),
);

export default router;
