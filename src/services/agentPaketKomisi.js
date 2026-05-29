// Stage 14 — per-paket × per-agent komisi override.
//
// Drives the rate chain in payment.js: when an `(agentId, paketId)` row
// exists here, its `rate` beats `AgentProfile.komisiRateOverride` and
// `Paket.komisiRate`. Historical Komisi rows are NEVER recomputed when
// these change — the rate at LUNAS is locked into Komisi.amount.
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const RateSchema = z.object({
  agentId: z.string().trim().min(1, 'agentId wajib'),
  // Decimal(5,4) caps at 9.9999 — well above any plausible komisi %. Reject
  // negative + values > 1 with a clear message; 0 is allowed (deliberate
  // exclusion of an agent from komisi on this paket).
  rate: z.coerce.number()
    .min(0, 'Rate harus >= 0')
    .max(1, 'Rate maksimum 100% (1.0)'),
});

async function loadPaketIdBySlug(slug) {
  const row = await db.paket.findUnique({ where: { slug }, select: { id: true } });
  if (!row) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  return row.id;
}

async function loadAgentExists(agentId) {
  const row = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: { id: true, slug: true, displayName: true },
  });
  if (!row) throw new HttpError(404, 'Agent tidak ditemukan', 'AGENT_NOT_FOUND');
  return row;
}

/**
 * List all per-agent overrides for a paket, joined with agent identity for
 * the UI table. Returned newest-first so a fresh add bubbles to top.
 */
export async function listPaketOverrides(paketSlug) {
  const paketId = await loadPaketIdBySlug(paketSlug);
  return db.agentPaketKomisi.findMany({
    where: { paketId },
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { id: true, slug: true, displayName: true } },
    },
  });
}

/**
 * Upsert a single (agent, paket) override. Idempotent — same rate twice
 * lands the same row. When the rate changes, the row updates in place;
 * any already-EARNED/PAID Komisi rows are untouched (5u/5v invariant
 * carries over to this surface).
 */
export async function setPaketOverride({ req, actor, paketSlug, input }) {
  const paketId = await loadPaketIdBySlug(paketSlug);
  const parsed = RateSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input tidak valid', 'BAD_INPUT');
  }
  const agent = await loadAgentExists(parsed.data.agentId);
  const rate = parsed.data.rate;

  const existing = await db.agentPaketKomisi.findUnique({
    where: { agentId_paketId: { agentId: agent.id, paketId } },
  });
  const row = await db.agentPaketKomisi.upsert({
    where: { agentId_paketId: { agentId: agent.id, paketId } },
    create: { agentId: agent.id, paketId, rate },
    update: { rate },
  });
  // Skip audit on no-op writes — keeps the audit log focused.
  const oldRate = existing ? Number(existing.rate.toString()) : null;
  if (oldRate !== rate) {
    await audit({
      req, actor,
      action: existing ? 'PRICE_CHANGE' : 'CREATE',
      entity: 'AgentPaketKomisi',
      entityId: `${agent.id}:${paketId}`,
      before: existing ? { rate: oldRate } : undefined,
      after: { rate, agentSlug: agent.slug, paketSlug },
    });
  }
  return row;
}

/**
 * Remove an override. Falls back to the next tier in the rate chain
 * (per-agent override → paket rate) for future LUNAS transitions; existing
 * Komisi rows stay locked.
 */
export async function clearPaketOverride({ req, actor, paketSlug, agentId }) {
  const paketId = await loadPaketIdBySlug(paketSlug);
  const existing = await db.agentPaketKomisi.findUnique({
    where: { agentId_paketId: { agentId, paketId } },
  });
  if (!existing) {
    // 404 — caller asked to delete something that isn't there.
    throw new HttpError(404, 'Override tidak ditemukan', 'OVERRIDE_NOT_FOUND');
  }
  await db.agentPaketKomisi.delete({
    where: { agentId_paketId: { agentId, paketId } },
  });
  await audit({
    req, actor,
    action: 'DELETE',
    entity: 'AgentPaketKomisi',
    entityId: `${agentId}:${paketId}`,
    before: { rate: Number(existing.rate.toString()) },
    after: { fallsBackToChain: true },
  });
  return { ok: true };
}
