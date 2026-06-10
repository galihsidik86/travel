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
    // Stage 169 — duplicate phone warning. Mirrors S167's pre-flight
    // check but tailored for JSON: returns 409 `DUPLICATE_LEAD` with
    // the matching rows; client (agen-crm modal) shows warning + asks
    // user to confirm with `confirmDuplicate: true` before resubmitting.
    const confirmed = req.body?.confirmDuplicate === true || req.body?.confirmDuplicate === 'true';
    if (!confirmed && req.body?.phone) {
      const { findRecentLeadsByPhone, findRecentBookingsByPhone } = await import('../services/bookingDuplicateCheck.js');
      const [dupLeads, dupBookings] = await Promise.all([
        findRecentLeadsByPhone({ phone: req.body.phone, agentId: req.agentProfile.id }),
        findRecentBookingsByPhone({ phone: req.body.phone }),
      ]);
      if (dupLeads.length > 0 || dupBookings.length > 0) {
        return res.status(409).json({
          error: { code: 'DUPLICATE_LEAD', message: 'Telepon ini sudah punya lead atau booking aktif' },
          duplicates: {
            leads: dupLeads.map((l) => ({
              id: l.id, fullName: l.fullName, status: l.status,
              source: l.source, createdAt: l.createdAt,
            })),
            bookings: dupBookings.map((b) => ({
              id: b.id, bookingNo: b.bookingNo, fullName: b.jemaah?.fullName,
              paketTitle: b.paket?.title, status: b.status, createdAt: b.createdAt,
            })),
          },
        });
      }
    }
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
