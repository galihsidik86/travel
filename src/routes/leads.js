import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { createBooking } from '../services/booking.js';

const router = Router();

const SOURCES = ['WA', 'IG', 'FB', 'TIKTOK', 'WALK_IN', 'REFERRAL', 'AD', 'OTHER'];
const STATUSES = ['COLD', 'WARM', 'LOST'];
const KELAS_VALUES = ['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP'];

// Coerce empty strings from HTML forms to undefined, then validate
const optStr = z.preprocess((v) => (v === '' || v == null ? undefined : v), z.string().optional());
const optInt = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().int().positive().optional(),
);
const optMoney = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().nonnegative().optional(),
);

const CreateSchema = z.object({
  fullName: z.string().min(2).max(190),
  phone: z.string().min(8).max(30),
  email: optStr.pipe(z.string().email().optional()).optional(),
  notes: optStr,
  source: z.enum(SOURCES).default('OTHER'),
  status: z.enum(['COLD', 'WARM']).default('COLD'),
  interestedPaketSlug: optStr,
  interestedKelas: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(KELAS_VALUES).optional(),
  ),
  estPaxCount: optInt,
  estValueIdr: optMoney,
  score: z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().int().min(0).max(100).optional(),
  ),
  followUpAt: optStr.pipe(z.string().datetime({ offset: true }).optional()).optional(),
});

const UpdateSchema = CreateSchema.partial().extend({
  status: z.enum(STATUSES).optional(),
});

// Resolve the AgentProfile for the logged-in AGEN user, attach to req.agentProfile
const resolveAgent = asyncHandler(async (req, _res, next) => {
  const profile = await db.agentProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) throw new HttpError(404, 'Profil agen belum dibuat untuk akun ini', 'AGENT_PROFILE_MISSING');
  req.agentProfile = profile;
  next();
});

router.use(requireAuth, requireRole('AGEN'), resolveAgent);

// POST /api/leads — create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = CreateSchema.parse(req.body);
    const lead = await db.lead.create({
      data: {
        agentId: req.agentProfile.id,
        fullName: data.fullName,
        phone: data.phone,
        email: data.email ?? null,
        notes: data.notes ?? null,
        source: data.source,
        status: data.status,
        interestedPaketSlug: data.interestedPaketSlug ?? null,
        interestedKelas: data.interestedKelas ?? null,
        estPaxCount: data.estPaxCount ?? null,
        estValueIdr: data.estValueIdr != null ? data.estValueIdr.toFixed(2) : null,
        score: data.score ?? null,
        followUpAt: data.followUpAt ? new Date(data.followUpAt) : null,
      },
    });
    await audit({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'CREATE',
      entity: 'Lead',
      entityId: lead.id,
      after: { fullName: lead.fullName, source: lead.source, status: lead.status },
    });
    res.status(201).json({ lead });
  }),
);

// Helper: load a lead and assert ownership
async function loadOwnedLead(id, agentId) {
  const lead = await db.lead.findUnique({ where: { id } });
  if (!lead || lead.deletedAt) throw new HttpError(404, 'Lead tidak ditemukan', 'LEAD_NOT_FOUND');
  if (lead.agentId !== agentId) throw new HttpError(403, 'Anda tidak berhak mengakses lead ini', 'FORBIDDEN');
  return lead;
}

// PATCH /api/leads/:id — update fields and/or status
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const before = await loadOwnedLead(req.params.id, req.agentProfile.id);
    const patch = UpdateSchema.parse(req.body);

    const data = {};
    if (patch.fullName !== undefined) data.fullName = patch.fullName;
    if (patch.phone !== undefined) data.phone = patch.phone;
    if (patch.email !== undefined) data.email = patch.email ?? null;
    if (patch.notes !== undefined) data.notes = patch.notes ?? null;
    if (patch.source !== undefined) data.source = patch.source;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.interestedPaketSlug !== undefined) data.interestedPaketSlug = patch.interestedPaketSlug ?? null;
    if (patch.interestedKelas !== undefined) data.interestedKelas = patch.interestedKelas ?? null;
    if (patch.estPaxCount !== undefined) data.estPaxCount = patch.estPaxCount ?? null;
    if (patch.estValueIdr !== undefined) data.estValueIdr = patch.estValueIdr != null ? patch.estValueIdr.toFixed(2) : null;
    if (patch.score !== undefined) data.score = patch.score ?? null;
    if (patch.followUpAt !== undefined) data.followUpAt = patch.followUpAt ? new Date(patch.followUpAt) : null;

    const lead = await db.lead.update({ where: { id: before.id }, data });
    await audit({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'UPDATE',
      entity: 'Lead',
      entityId: lead.id,
      before: { status: before.status, fullName: before.fullName },
      after: { status: lead.status, fullName: lead.fullName, changed: Object.keys(data) },
    });
    res.json({ lead });
  }),
);

// POST /api/leads/:id/convert — promote lead to a real Booking
const ConvertSchema = z.object({
  paketSlug: z.string().min(1, 'Paket wajib dipilih').max(190),
  kelas: z.enum(KELAS_VALUES),
  paxCount: z.preprocess((v) => Number(v), z.number().int().min(1).max(20)),
  notes: optStr,
});

router.post(
  '/:id/convert',
  asyncHandler(async (req, res) => {
    const lead = await loadOwnedLead(req.params.id, req.agentProfile.id);
    if (lead.convertedAt) {
      throw new HttpError(409, 'Lead ini sudah dikonversi menjadi booking', 'LEAD_ALREADY_CONVERTED');
    }
    if (lead.status === 'LOST') {
      throw new HttpError(409, 'Lead yang sudah LOST tidak bisa dikonversi', 'LEAD_LOST');
    }

    const input = ConvertSchema.parse(req.body);

    // Reuse the public booking-creation service. agentSlug from logged-in agent
    // (NOT lead.interestedPaketSlug — that field is informational only).
    const { booking, paket, jemaah } = await createBooking({
      req,
      paketSlug: input.paketSlug,
      agentSlug: req.agentProfile.slug,
      fullName: lead.fullName,
      phone: lead.phone,
      kelas: input.kelas,
      paxCount: input.paxCount,
      notes: input.notes ?? lead.notes ?? null,
    });

    const updatedLead = await db.lead.update({
      where: { id: lead.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        convertedBookingId: booking.id,
      },
    });

    await audit({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'UPDATE',
      entity: 'Lead',
      entityId: lead.id,
      before: { status: lead.status, convertedBookingId: null },
      after: { status: 'CONVERTED', convertedBookingId: booking.id, bookingNo: booking.bookingNo },
    });

    res.status(201).json({
      lead: updatedLead,
      booking: { id: booking.id, bookingNo: booking.bookingNo, paketTitle: paket.title, jemaahId: jemaah.id },
    });
  }),
);

// DELETE /api/leads/:id — soft delete
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const before = await loadOwnedLead(req.params.id, req.agentProfile.id);
    await db.lead.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await audit({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'DELETE',
      entity: 'Lead',
      entityId: before.id,
      before: { fullName: before.fullName, status: before.status },
    });
    res.json({ ok: true });
  }),
);

export default router;
