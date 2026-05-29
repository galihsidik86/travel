// Admin incidents queue + detail.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listIncidents, getIncident, ackIncident, resolveIncident, TYPE_LABELS,
} from '../services/incidents.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await listIncidents({
      status: req.query.status || 'ALL',
      type: req.query.type || 'ALL',
      page: req.query.page || 1,
    });
    res.render('incidents-list', {
      user: req.user,
      ...result,
      filters: { status: req.query.status || 'ALL', type: req.query.type || 'ALL' },
      typeLabels: TYPE_LABELS,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const incident = await getIncident(req.params.id);
    if (!incident) throw new HttpError(404, 'Insiden tidak ditemukan', 'NOT_FOUND');
    res.render('incident-detail', {
      user: req.user, incident, typeLabels: TYPE_LABELS,
      flash: { ack: req.query.ack === 'ok', resolved: req.query.resolved === 'ok' },
    });
  }),
);

router.post(
  '/:id/ack',
  asyncHandler(async (req, res) => {
    await ackIncident({ req, adminUser: req.user, id: req.params.id });
    res.redirect(`/admin/incidents/${req.params.id}?ack=ok`);
  }),
);

router.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    await resolveIncident({
      req, adminUser: req.user, id: req.params.id,
      input: { resolution: req.body?.resolution || '' },
    });
    res.redirect(`/admin/incidents/${req.params.id}?resolved=ok`);
  }),
);

export default router;
