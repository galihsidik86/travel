import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { listAudits, getAuditActivity, getAuditById, ENTITIES, ACTIONS } from '../services/auditLog.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      entity: req.query.entity || 'ALL',
      action: req.query.action || 'ALL',
      actorEmail: (req.query.actorEmail || '').trim(),
      from: req.query.from || '',
      to: req.query.to || '',
      page: req.query.page || 1,
    };
    const [result, activity] = await Promise.all([
      listAudits(filters),
      getAuditActivity(filters),
    ]);
    res.render('audit-list', {
      user: req.user, ...result,
      activity,
      filters, ENTITIES, ACTIONS,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const entry = await getAuditById(req.params.id);
    if (!entry) throw new HttpError(404, 'Audit log tidak ditemukan', 'AUDIT_NOT_FOUND');
    res.render('audit-detail', { user: req.user, entry });
  }),
);

export default router;
