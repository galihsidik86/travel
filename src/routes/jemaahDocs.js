import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { upsertDoc, deleteDoc, bulkVerifyDocs } from '../services/jemaahDocs.js';

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

// Stage 248 — bulk verify multiple docs for one jemaah in one call.
// Body: { docIds: [...] }. Per-row failure caught; returns counters.
router.post(
  '/:id/documents/bulk-verify',
  asyncHandler(async (req, res) => {
    const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds : [];
    const result = await bulkVerifyDocs({
      req, actor: actorFrom(req),
      jemaahId: req.params.id,
      docIds,
    });
    res.json(result);
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
