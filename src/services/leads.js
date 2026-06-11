// Lead CRM service — extracted from src/routes/leads.js so it can be unit-
// tested against the DB directly without spinning up the HTTP layer.
//
// Route layer (src/routes/leads.js) is now a thin adapter: parse query +
// route param, call service, return JSON. All validation + auth-scoping
// (ownership via agentId) lives here.
import { z } from 'zod';

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { createBooking } from './booking.js';

export const LEAD_SOURCES = ['WA', 'IG', 'FB', 'TIKTOK', 'WALK_IN', 'REFERRAL', 'AD', 'OTHER'];
export const LEAD_STATUSES = ['COLD', 'WARM', 'LOST'];
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

export const LeadCreateSchema = z.object({
  fullName: z.string().min(2).max(190),
  phone: z.string().min(8).max(30),
  email: optStr.pipe(z.string().email().optional()).optional(),
  notes: optStr,
  source: z.enum(LEAD_SOURCES).default('OTHER'),
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

// Update permits LOST too (status machine: COLD/WARM ↔ LOST; CONVERTED only
// reachable via convertLeadToBooking, which writes that status directly).
export const LeadUpdateSchema = LeadCreateSchema.partial().extend({
  status: z.enum(LEAD_STATUSES).optional(),
});

export const LeadConvertSchema = z.object({
  paketSlug: z.string().min(1, 'Paket wajib dipilih').max(190),
  kelas: z.enum(KELAS_VALUES),
  paxCount: z.preprocess((v) => Number(v), z.number().int().min(1).max(20)),
  notes: optStr,
});

/**
 * Load + assert ownership. 404 generic when missing or soft-deleted; 403
 * when the lead belongs to a different agent.
 */
export async function loadOwnedLead(leadId, agentId) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.deletedAt) throw new HttpError(404, 'Lead tidak ditemukan', 'LEAD_NOT_FOUND');
  if (lead.agentId !== agentId) throw new HttpError(403, 'Anda tidak berhak mengakses lead ini', 'FORBIDDEN');
  return lead;
}

/**
 * Create a lead owned by the given agent. Money is stored as Decimal string
 * with .toFixed(2) so the schema's Decimal precision is preserved.
 */
export async function createLead({ req, actor, agentId, input }) {
  const data = LeadCreateSchema.parse(input);
  const lead = await db.lead.create({
    data: {
      agentId,
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
    req, actor,
    action: 'CREATE', entity: 'Lead', entityId: lead.id,
    after: { fullName: lead.fullName, source: lead.source, status: lead.status },
  });
  return lead;
}

/**
 * Patch a lead's mutable fields. Each property is only written when explicitly
 * present in `input` (true PATCH semantics — undefined = "no change").
 */
export async function updateLead({ req, actor, agentId, leadId, input }) {
  const before = await loadOwnedLead(leadId, agentId);
  const patch = LeadUpdateSchema.parse(input);

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
    req, actor,
    action: 'UPDATE', entity: 'Lead', entityId: lead.id,
    before: { status: before.status, fullName: before.fullName },
    after: { status: lead.status, fullName: lead.fullName, changed: Object.keys(data) },
  });
  return lead;
}

/**
 * Promote a lead to a real Booking via the public booking-creation service.
 *
 * State machine guards:
 *   - already CONVERTED → 409 LEAD_ALREADY_CONVERTED (use convertedAt sentinel)
 *   - LOST              → 409 LEAD_LOST (terminal-failed leads can't be revived)
 *
 * Agent attribution uses the CALLER's agent.slug (not lead.interestedPaketSlug,
 * which is informational only).
 */
export async function convertLeadToBooking({ req, actor, agent, leadId, input }) {
  const lead = await loadOwnedLead(leadId, agent.id);
  if (lead.convertedAt) {
    throw new HttpError(409, 'Lead ini sudah dikonversi menjadi booking', 'LEAD_ALREADY_CONVERTED');
  }
  if (lead.status === 'LOST') {
    throw new HttpError(409, 'Lead yang sudah LOST tidak bisa dikonversi', 'LEAD_LOST');
  }
  const data = LeadConvertSchema.parse(input);

  const { booking, paket, jemaah } = await createBooking({
    req,
    paketSlug: data.paketSlug,
    agentSlug: agent.slug,
    fullName: lead.fullName,
    phone: lead.phone,
    kelas: data.kelas,
    paxCount: data.paxCount,
    notes: data.notes ?? lead.notes ?? null,
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
    req, actor,
    action: 'UPDATE', entity: 'Lead', entityId: lead.id,
    before: { status: lead.status, convertedBookingId: null },
    after: { status: 'CONVERTED', convertedBookingId: booking.id, bookingNo: booking.bookingNo },
  });

  return { lead: updatedLead, booking, paket, jemaah };
}

/**
 * Soft-delete a lead (sets deletedAt). The lead row stays for audit purposes;
 * `loadOwnedLead` filters out soft-deleted rows so they appear gone to the agent.
 */
export async function deleteLead({ req, actor, agentId, leadId }) {
  const before = await loadOwnedLead(leadId, agentId);
  await db.lead.update({
    where: { id: before.id },
    data: { deletedAt: new Date() },
  });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Lead', entityId: before.id,
    before: { fullName: before.fullName, status: before.status },
  });
}

/**
 * Stage 189 — reactivate an archived (soft-deleted) lead. Admin-side
 * tool surfaced on /admin/jemaah/:id/edit's S59 archived-leads panel
 * for the case "jemaah re-engaged after months, want to work them
 * again with the prior context intact".
 *
 * Clears `deletedAt` + flips status back to COLD (a re-engagement
 * is fresh contact, not a continuation of the prior WARM heat).
 * Only LOST + non-terminal archived rows can be reactivated; CONVERTED
 * rows are blocked (already became a booking) even if soft-deleted by
 * the S57 prune sweep.
 *
 * No agent ownership check here — admin acts on behalf of the agent
 * who originally owned the lead, and the row stays under the same
 * `agentId`. RBAC enforced at the route layer.
 */
export async function reactivateLead({ req, actor, leadId }) {
  const before = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, fullName: true, status: true, deletedAt: true, agentId: true },
  });
  if (!before) {
    throw new HttpError(404, 'Lead tidak ditemukan', 'LEAD_NOT_FOUND');
  }
  if (before.deletedAt == null) {
    // Already active — idempotent return (no audit pollution)
    return { reactivated: false, reason: 'already_active', lead: before };
  }
  if (before.status === 'CONVERTED') {
    throw new HttpError(409, 'Lead sudah CONVERTED — tidak bisa di-reactivate', 'LEAD_TERMINAL');
  }
  const updated = await db.lead.update({
    where: { id: leadId },
    data: { deletedAt: null, status: 'COLD' },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Lead', entityId: leadId,
    before: { deletedAt: before.deletedAt.toISOString(), status: before.status },
    after: { deletedAt: null, status: 'COLD', reactivated: true },
  });
  return { reactivated: true, lead: updated };
}

/**
 * Stage 186 — bulk mark-as-LOST. Agen selects N COLD/WARM leads on the
 * CRM kanban and applies "Tandai LOST" to clean up stale pipeline in
 * one shot.
 *
 * Per-row ownership enforced (cross-agent IDs silently skipped, NOT a
 * 403, because the kanban filter already scopes by agent — a cross-
 * agent id arriving here is a stale browser tab or someone fuzzing).
 *
 * Already-LOST and CONVERTED rows are skipped (terminal). Audit row
 * per actually-changed lead so the timeline reflects the bulk action
 * as one event per lead, not a batched aggregate.
 */
export async function bulkMarkLeadsLost({ req, actor, agentId, leadIds }) {
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return { changed: 0, skipped: 0, total: 0 };
  }
  // Cap defensively — a runaway client could send a huge array
  const capped = leadIds.slice(0, 500);
  // Pull all candidate rows in one query, filtered by ownership
  const rows = await db.lead.findMany({
    where: {
      id: { in: capped }, agentId, deletedAt: null,
      status: { notIn: ['LOST', 'CONVERTED'] },
    },
    select: { id: true, fullName: true, status: true },
  });
  if (rows.length === 0) {
    return { changed: 0, skipped: capped.length, total: capped.length };
  }
  // Single updateMany — atomic at the row level
  const now = new Date();
  await db.lead.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'LOST', updatedAt: now },
  });
  // One audit row per actually-changed lead — same shape as updateLead
  // so the timeline reads consistently.
  for (const r of rows) {
    await audit({
      req, actor,
      action: 'UPDATE', entity: 'Lead', entityId: r.id,
      before: { status: r.status },
      after: { status: 'LOST', bulkMarkLost: true },
    });
  }
  return {
    changed: rows.length,
    skipped: capped.length - rows.length,
    total: capped.length,
  };
}
