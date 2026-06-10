// Stage 166 — agent payout banking details. Self-service via
// updateAgentPayoutDetails; pre-fills /admin/payouts/new for KASIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, fakeReq, systemActor } from './_helpers.js';
import { updateAgentPayoutDetails } from '../src/services/agentPayoutDetails.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'AgentProfile', entityId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('updateAgentPayoutDetails: sets full details + audit row', async (t) => {
  const tag = makeTag('s166-set');
  const u = await tempAgent(t, tag);
  const r = await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: {
      preferredPayoutMethod: 'TRANSFER',
      bankName: 'BCA', bankAccountNumber: '1234567890',
      bankAccountName: 'Ahmad W',
    },
  });
  assert.equal(r.updated, true);
  assert.equal(r.agent.preferredPayoutMethod, 'TRANSFER');
  assert.equal(r.agent.bankName, 'BCA');
  assert.equal(r.agent.bankAccountNumber, '1234567890');
  assert.equal(r.agent.bankAccountName, 'Ahmad W');

  const audits = await db.auditLog.findMany({
    where: { entity: 'AgentProfile', entityId: u.agent.id, action: 'UPDATE' },
  });
  assert.equal(audits.length, 1);
  // Account number masked in audit snapshot
  assert.match(audits[0].after.bankAccountNumber, /^12.*90$/);
  assert.match(audits[0].after.bankAccountNumber, /\*/);
});

test('updateAgentPayoutDetails: empty string clears value to null', async (t) => {
  const tag = makeTag('s166-clear');
  const u = await tempAgent(t, tag);
  await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { bankName: 'BCA', bankAccountNumber: '999' },
  });
  // Now clear via empty string
  const r = await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { bankName: '', bankAccountNumber: '' },
  });
  assert.equal(r.updated, true);
  assert.equal(r.agent.bankName, null);
  assert.equal(r.agent.bankAccountNumber, null);
});

test('updateAgentPayoutDetails: no-op when nothing changed → no audit', async (t) => {
  const tag = makeTag('s166-noop');
  const u = await tempAgent(t, tag);
  await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { bankName: 'BCA' },
  });
  const auditsBefore = await db.auditLog.count({
    where: { entity: 'AgentProfile', entityId: u.agent.id },
  });
  // Same value → updated:false, no new audit
  const r = await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { bankName: 'BCA' },
  });
  assert.equal(r.updated, false);
  const auditsAfter = await db.auditLog.count({
    where: { entity: 'AgentProfile', entityId: u.agent.id },
  });
  assert.equal(auditsAfter, auditsBefore, 'no audit row on no-op');
});

test('updateAgentPayoutDetails: rejects bad method enum', async (t) => {
  const tag = makeTag('s166-bad-method');
  const u = await tempAgent(t, tag);
  await assert.rejects(
    updateAgentPayoutDetails({
      req: fakeReq, actor: systemActor, agentId: u.agent.id,
      input: { preferredPayoutMethod: 'BITCOIN' },
    }),
    /BAD_INPUT|Input|Invalid|enum/,
  );
});

test('updateAgentPayoutDetails: lower-case method normalised', async (t) => {
  const tag = makeTag('s166-norm');
  const u = await tempAgent(t, tag);
  const r = await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { preferredPayoutMethod: 'transfer' },
  });
  assert.equal(r.updated, true);
  assert.equal(r.agent.preferredPayoutMethod, 'TRANSFER');
});

test('updateAgentPayoutDetails: bad agent id → AGENT_NOT_FOUND', async () => {
  await assert.rejects(
    updateAgentPayoutDetails({
      req: fakeReq, actor: systemActor, agentId: 'does-not-exist',
      input: { bankName: 'BCA' },
    }),
    /AGENT_NOT_FOUND|tidak ditemukan/,
  );
});

test('updateAgentPayoutDetails: short account number not masked', async (t) => {
  const tag = makeTag('s166-short');
  const u = await tempAgent(t, tag);
  await updateAgentPayoutDetails({
    req: fakeReq, actor: systemActor, agentId: u.agent.id,
    input: { bankAccountNumber: '12' },
  });
  const audit = await db.auditLog.findFirst({
    where: { entity: 'AgentProfile', entityId: u.agent.id, action: 'UPDATE' },
  });
  // 2-char acct stays unmasked (≤ 4 chars threshold)
  assert.equal(audit.after.bankAccountNumber, '12');
});
