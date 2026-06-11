// Stage 189 — reactivate an archived (soft-deleted) lead from the
// admin /admin/jemaah/:id/edit S59 hint panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, fakeReq, systemActor } from './_helpers.js';
import { reactivateLead } from '../src/services/leads.js';
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
    await db.auditLog.deleteMany({ where: { entity: 'Lead' } });
    await db.lead.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('reactivateLead: unknown id → LEAD_NOT_FOUND', async () => {
  await assert.rejects(
    reactivateLead({
      req: fakeReq, actor: systemActor, leadId: 'does-not-exist',
    }),
    /LEAD_NOT_FOUND|tidak ditemukan/,
  );
});

test('reactivateLead: already-active lead → idempotent no-op', async (t) => {
  const tag = makeTag('s189-active');
  const u = await tempAgent(t, tag);
  const live = await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'L', phone: '0811', status: 'COLD', source: 'WA' },
  });
  const r = await reactivateLead({
    req: fakeReq, actor: systemActor, leadId: live.id,
  });
  assert.equal(r.reactivated, false);
  assert.equal(r.reason, 'already_active');
});

test('reactivateLead: archived COLD lead → status reset to COLD + deletedAt cleared', async (t) => {
  const tag = makeTag('s189-revive');
  const u = await tempAgent(t, tag);
  const archived = await db.lead.create({
    data: {
      agentId: u.agent.id, fullName: 'L', phone: '0811',
      status: 'COLD', source: 'WA',
      deletedAt: new Date('2025-06-01'),
    },
  });
  const r = await reactivateLead({
    req: fakeReq, actor: systemActor, leadId: archived.id,
  });
  assert.equal(r.reactivated, true);

  const after = await db.lead.findUnique({ where: { id: archived.id } });
  assert.equal(after.deletedAt, null);
  assert.equal(after.status, 'COLD');

  const audits = await db.auditLog.findMany({
    where: { entity: 'Lead', entityId: archived.id, action: 'UPDATE' },
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.reactivated, true);
  assert.equal(audits[0].after.status, 'COLD');
});

test('reactivateLead: archived LOST lead → flips to COLD (fresh re-engagement)', async (t) => {
  const tag = makeTag('s189-lost');
  const u = await tempAgent(t, tag);
  const archived = await db.lead.create({
    data: {
      agentId: u.agent.id, fullName: 'L', phone: '0811',
      status: 'LOST', source: 'WA',
      deletedAt: new Date('2025-01-01'),
    },
  });
  await reactivateLead({
    req: fakeReq, actor: systemActor, leadId: archived.id,
  });
  const after = await db.lead.findUnique({ where: { id: archived.id } });
  assert.equal(after.status, 'COLD', 'LOST flips to COLD on reactivation');
  assert.equal(after.deletedAt, null);
});

test('reactivateLead: CONVERTED lead → blocked even when soft-deleted', async (t) => {
  const tag = makeTag('s189-conv');
  const u = await tempAgent(t, tag);
  const archived = await db.lead.create({
    data: {
      agentId: u.agent.id, fullName: 'L', phone: '0811',
      status: 'CONVERTED', source: 'WA',
      deletedAt: new Date('2025-01-01'),
    },
  });
  await assert.rejects(
    reactivateLead({ req: fakeReq, actor: systemActor, leadId: archived.id }),
    /LEAD_TERMINAL|CONVERTED/,
  );
  // Row still soft-deleted, status untouched
  const after = await db.lead.findUnique({ where: { id: archived.id } });
  assert.ok(after.deletedAt);
  assert.equal(after.status, 'CONVERTED');
});

test('reactivateLead: agentId stays the same (not re-attributed)', async (t) => {
  const tag = makeTag('s189-attrib');
  const u = await tempAgent(t, tag);
  const archived = await db.lead.create({
    data: {
      agentId: u.agent.id, fullName: 'L', phone: '0811',
      status: 'COLD', source: 'WA',
      deletedAt: new Date('2025-06-01'),
    },
  });
  await reactivateLead({
    req: fakeReq, actor: systemActor, leadId: archived.id,
  });
  const after = await db.lead.findUnique({ where: { id: archived.id } });
  assert.equal(after.agentId, u.agent.id, 'agentId unchanged');
});
