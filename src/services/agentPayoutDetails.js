// Stage 166 — agent payout banking details. Self-service via
// /agen/profile/payout-details + admin-side viewer on user-edit.
// Pre-fills /admin/payouts/new so KASIR doesn't have to ask the
// agent every payout cycle.
//
// All 4 fields are optional — agents who prefer cash-in-person
// don't need to fill bank info. Empty string → null (3-state to
// distinguish "clear" from "not provided").

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const ALLOWED_METHODS = ['TRANSFER', 'CASH', 'EWALLET', 'QRIS'];

// 3-state preprocessor: undefined → no change, '' → null, value → trimmed
function nullable(maxLen) {
  return z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    },
    z.string().max(maxLen).nullable().optional(),
  );
}

export const PayoutDetailsSchema = z.object({
  preferredPayoutMethod: z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      return String(v).trim().toUpperCase();
    },
    z.enum(ALLOWED_METHODS).nullable().optional(),
  ),
  bankName: nullable(80),
  bankAccountNumber: nullable(40),
  bankAccountName: nullable(100),
});

export async function updateAgentPayoutDetails({
  req, actor, agentId, input,
}) {
  const parsed = PayoutDetailsSchema.safeParse(input || {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input tidak valid', 'BAD_INPUT');
  }
  const before = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: {
      preferredPayoutMethod: true, bankName: true,
      bankAccountNumber: true, bankAccountName: true,
    },
  });
  if (!before) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');

  // Skip-audit-on-no-op: build the diff and abort if nothing changed.
  // Treats `undefined` as "no change" so JSON callers can omit keys
  // and form callers (which always include all fields) get the right
  // diff vs the form value.
  const updates = {};
  for (const key of ['preferredPayoutMethod', 'bankName', 'bankAccountNumber', 'bankAccountName']) {
    const v = parsed.data[key];
    if (v === undefined) continue;
    if (v !== before[key]) updates[key] = v;
  }
  if (Object.keys(updates).length === 0) {
    return { updated: false };
  }

  const after = await db.agentProfile.update({
    where: { id: agentId },
    data: updates,
    select: {
      id: true, slug: true,
      preferredPayoutMethod: true, bankName: true,
      bankAccountNumber: true, bankAccountName: true,
    },
  });

  await audit({
    req, actor,
    action: 'UPDATE',
    entity: 'AgentProfile',
    entityId: agentId,
    before: maskAccount(before),
    after: maskAccount({
      preferredPayoutMethod: after.preferredPayoutMethod,
      bankName: after.bankName,
      bankAccountNumber: after.bankAccountNumber,
      bankAccountName: after.bankAccountName,
      payoutDetailsUpdated: true,
    }),
  });

  return { updated: true, agent: after };
}

// Mask the middle digits of the account number in audit snapshots —
// the full value is in the live DB row, but the audit log is a
// secondary surface that admins grep through; partial masking limits
// damage if the audit table leaks.
function maskAccount(snap) {
  if (!snap) return snap;
  const out = { ...snap };
  const acct = out.bankAccountNumber;
  if (typeof acct === 'string' && acct.length > 4) {
    out.bankAccountNumber = acct.slice(0, 2) + '*'.repeat(Math.max(0, acct.length - 4)) + acct.slice(-2);
  }
  return out;
}
