// HTTP adapter for lead CRM. All validation + business logic lives in
// src/services/leads.js — this file only handles request parsing,
// auth scoping (resolveAgent attaches the AgentProfile), and JSON envelopes.
import { Router } from 'express';

import { db } from '../lib/db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  createLead, updateLead, convertLeadToBooking, deleteLead,
} from '../services/leads.js';

const router = Router();

// Resolve the AgentProfile for the logged-in AGEN user, attach to req.agentProfile
const resolveAgent = asyncHandler(async (req, _res, next) => {
  const profile = await db.agentProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) throw new HttpError(404, 'Profil agen belum dibuat untuk akun ini', 'AGENT_PROFILE_MISSING');
  req.agentProfile = profile;
  next();
});

router.use(requireAuth, requireRole('AGEN'), resolveAgent);

const actorFrom = (req) => ({ id: req.user.id, email: req.user.email, role: req.user.role });

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const lead = await createLead({
      req, actor: actorFrom(req),
      agentId: req.agentProfile.id,
      input: req.body,
    });
    res.status(201).json({ lead });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const lead = await updateLead({
      req, actor: actorFrom(req),
      agentId: req.agentProfile.id,
      leadId: req.params.id,
      input: req.body,
    });
    res.json({ lead });
  }),
);

router.post(
  '/:id/convert',
  asyncHandler(async (req, res) => {
    const { lead, booking, paket, jemaah } = await convertLeadToBooking({
      req, actor: actorFrom(req),
      agent: req.agentProfile,
      leadId: req.params.id,
      input: req.body,
    });
    res.status(201).json({
      lead,
      booking: { id: booking.id, bookingNo: booking.bookingNo, paketTitle: paket.title, jemaahId: jemaah.id },
    });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteLead({
      req, actor: actorFrom(req),
      agentId: req.agentProfile.id,
      leadId: req.params.id,
    });
    res.json({ ok: true });
  }),
);

export default router;
