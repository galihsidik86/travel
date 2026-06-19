// Admin incidents queue + detail.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listIncidents, getIncident, ackIncident, resolveIncident, TYPE_LABELS,
} from '../services/incidents.js';
import { getIncidentSlaReport } from '../services/incidentSla.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [result, sla] = await Promise.all([
      listIncidents({
        status: req.query.status || 'ALL',
        type: req.query.type || 'ALL',
        page: req.query.page || 1,
      }),
      // Stage 83 — best-effort; a report failure must NOT break the queue page
      getIncidentSlaReport({ weeks: 8 }).catch((err) => {
        console.warn('[incidents] SLA report failed:', err?.message || err);
        return null;
      }),
    ]);
    res.render('incidents-list', {
      user: req.user,
      ...result,
      filters: { status: req.query.status || 'ALL', type: req.query.type || 'ALL' },
      typeLabels: TYPE_LABELS,
      sla,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const incident = await getIncident(req.params.id);
    if (!incident) throw new HttpError(404, 'Insiden tidak ditemukan', 'NOT_FOUND');
    // Stage 89 — pass SLA budget for the incident's type so the timeline
    // can draw budget markers + flag breaches inline.
    const { SLA_BUDGETS } = await import('../services/incidentSlaAlert.js');
    const slaBudget = SLA_BUDGETS[incident.type] || null;
    res.render('incident-detail', {
      user: req.user, incident, typeLabels: TYPE_LABELS, slaBudget,
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

// Stage 373 — admin photo download. Inline so browsers render directly.
// 404 (not 403) on missing photo to avoid leaking which incidents do/don't
// have evidence attached based on response code.
router.get(
  '/:id/photo',
  asyncHandler(async (req, res) => {
    const incident = await getIncident(req.params.id);
    if (!incident || !incident.photoPath) {
      throw new HttpError(404, 'Foto tidak ditemukan', 'NO_PHOTO');
    }
    const { absFromRel } = await import('../lib/incidentStorage.js');
    const abs = absFromRel(incident.photoPath);
    res.type(incident.photoMime || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${incident.photoName || 'photo.jpg'}"`);
    res.sendFile(abs, (err) => {
      if (err) {
        console.warn('[incidents] photo send failed:', err?.message || err);
        if (!res.headersSent) res.status(404).send('Photo not available');
      }
    });
  }),
);

export default router;
