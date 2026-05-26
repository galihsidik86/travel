import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { upsertDoc, deleteDoc } from '../services/jemaahDocs.js';

const router = Router({ mergeParams: true });

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

// POST /api/jemaah/:id/documents — upsert by (jemaahId, type)
router.post(
  '/:id/documents',
  asyncHandler(async (req, res) => {
    const doc = await upsertDoc({
      req, actor: actorFrom(req),
      jemaahId: req.params.id, input: req.body,
    });
    res.status(201).json({ doc });
  }),
);

// DELETE /api/jemaah/:id/documents/:docId
router.delete(
  '/:id/documents/:docId',
  asyncHandler(async (req, res) => {
    await deleteDoc({
      req, actor: actorFrom(req),
      jemaahId: req.params.id, docId: req.params.docId,
    });
    res.json({ ok: true });
  }),
);

export default router;
