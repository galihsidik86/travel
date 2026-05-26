import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { toNumber } from '../lib/format.js';
import { notifyPayoutCreated } from './notifications.js';

const METHODS = ['TRANSFER', 'CASH', 'EWALLET', 'QRIS'];

export const CreatePayoutSchema = z.object({
  agentId: z.string().min(1, 'Pilih agen'),
  method: z.enum(METHODS),
  reference: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(190).nullable()),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(2000).nullable()),
});

/**
 * Payout number scheme: PO-YYYY-NNNNN. Mirrors `bookingNo`.
 * Counts prefix-matched rows; retries on collision (uniqueness via @unique).
 */
async function generatePayoutNo() {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.komisiPayout.count({ where: { payoutNo: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(5, '0')}`;
    const exists = await db.komisiPayout.findUnique({ where: { payoutNo: candidate } });
    if (!exists) return candidate;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

/**
 * Disburse all EARNED komisi for one agent in a single transaction.
 *   - Sums amount at the snapshot moment.
 *   - Creates KomisiPayout(payoutNo=PO-YYYY-NNNNN, snapshot amount, method, reference, paidBy=actor).
 *   - Bulk-updates the agent's EARNED rows: status=PAID + payoutId + paidAt = payout.paidAt.
 *   - Audit row carries summary + komisi count.
 *
 * Refuses if the agent has zero EARNED rows (nothing to pay out → 409).
 */
export async function createPayout({ req, actor, agentId, method, reference, notes }) {
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: { id: true, slug: true, displayName: true },
  });
  if (!agent) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');

  // Snapshot EARNED rows for this agent
  const earned = await db.komisi.findMany({
    where: { agentId, status: 'EARNED' },
    select: { id: true, amount: true, bookingId: true },
  });
  if (earned.length === 0) {
    throw new HttpError(409, `Tidak ada komisi EARNED untuk agen ${agent.displayName}`, 'NO_EARNED_KOMISI');
  }
  const total = earned.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0);
  if (total <= 0) {
    throw new HttpError(409, 'Total komisi 0 — tidak ada yang dibayar', 'NO_PAYABLE');
  }

  const payoutNo = await generatePayoutNo();
  const now = new Date();

  const payout = await db.$transaction(async (tx) => {
    const p = await tx.komisiPayout.create({
      data: {
        payoutNo,
        agentId,
        amount: total.toFixed(2),
        currency: 'IDR',
        method,
        reference: reference || null,
        notes: notes || null,
        paidAt: now,
        paidById: actor.id,
      },
    });
    await tx.komisi.updateMany({
      where: { id: { in: earned.map((k) => k.id) } },
      data: { status: 'PAID', payoutId: p.id, paidAt: now },
    });
    return p;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'KomisiPayout', entityId: payout.id,
    after: {
      payoutNo, agentSlug: agent.slug, agentDisplayName: agent.displayName,
      amount: total, method, reference: reference || null,
      komisiCount: earned.length,
      komisiIds: earned.map((k) => k.id),
    },
  });

  // Notif (non-blocking) — agent gets a WA about the disbursement
  try {
    const agentForNotif = await db.agentProfile.findUnique({
      where: { id: agentId },
      select: { whatsapp: true, displayName: true },
    });
    if (agentForNotif) await notifyPayoutCreated({ payout, agent: agentForNotif });
  } catch (err) {
    console.error('[payout] notif failed:', err.message);
  }

  return { payout, agent, komisiCount: earned.length };
}

/**
 * List payouts (most recent first) + computed outstanding-earned per agent.
 */
export async function listPayouts({ limit = 100 } = {}) {
  const [payouts, agents] = await Promise.all([
    db.komisiPayout.findMany({
      take: limit,
      orderBy: { paidAt: 'desc' },
      include: {
        agent: { select: { slug: true, displayName: true } },
        paidBy: { select: { email: true } },
        _count: { select: { komisi: true } },
      },
    }),
    db.agentProfile.findMany({
      select: {
        id: true, slug: true, displayName: true,
        komisi: {
          where: { status: 'EARNED' },
          select: { amount: true },
        },
      },
      orderBy: { displayName: 'asc' },
    }),
  ]);

  const outstanding = agents.map((a) => ({
    id: a.id,
    slug: a.slug,
    displayName: a.displayName,
    earnedTotal: a.komisi.reduce((acc, k) => acc + (toNumber(k.amount) ?? 0), 0),
    earnedCount: a.komisi.length,
  })).sort((a, b) => b.earnedTotal - a.earnedTotal);

  return { payouts, outstanding };
}

export async function getPayoutById(id) {
  return db.komisiPayout.findUnique({
    where: { id },
    include: {
      agent: { select: { slug: true, displayName: true, whatsapp: true } },
      paidBy: { select: { email: true } },
      komisi: {
        include: {
          booking: { select: { bookingNo: true, jemaah: { select: { fullName: true } }, paket: { select: { title: true } } } },
        },
      },
    },
  });
}

export const META = { METHODS };
