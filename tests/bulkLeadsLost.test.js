// Stage 186 — bulkMarkLeadsLost flips selected COLD/WARM leads to
// LOST with per-row ownership + status validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, fakeReq, systemActor } from './_helpers.js';
import { bulkMarkLeadsLost } from '../src/services/leads.js';
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

async function lead(agentId, status, fullName = 'L') {
  return db.lead.create({
    data: { agentId, fullName, phone: '0811', status, source: 'WA' },
  });
}

test('bulkMarkLeadsLost: empty array → no-op', async () => {
  const r = await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor, agentId: 'x', leadIds: [],
  });
  assert.equal(r.changed, 0);
  assert.equal(r.total, 0);
});

test('bulkMarkLeadsLost: flips COLD + WARM but skips terminal', async (t) => {
  const tag = makeTag('s186-flip');
  const u = await tempAgent(t, tag);
  const cold = await lead(u.agent.id, 'COLD');
  const warm = await lead(u.agent.id, 'WARM');
  const lost = await lead(u.agent.id, 'LOST');
  const converted = await lead(u.agent.id, 'CONVERTED');

  const r = await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor,
    agentId: u.agent.id,
    leadIds: [cold.id, warm.id, lost.id, converted.id],
  });
  assert.equal(r.changed, 2, 'only COLD + WARM flipped');
  assert.equal(r.skipped, 2);

  const after = await db.lead.findMany({
    where: { id: { in: [cold.id, warm.id, lost.id, converted.id] } },
    select: { id: true, status: true },
  });
  const byId = Object.fromEntries(after.map((l) => [l.id, l.status]));
  assert.equal(byId[cold.id], 'LOST');
  assert.equal(byId[warm.id], 'LOST');
  assert.equal(byId[lost.id], 'LOST', 'already LOST stays LOST');
  assert.equal(byId[converted.id], 'CONVERTED', 'CONVERTED unchanged');
});

test('bulkMarkLeadsLost: cross-agent IDs silently skipped', async (t) => {
  const tagA = makeTag('s186-A');
  const tagB = makeTag('s186-B');
  const uA = await tempAgent(t, tagA);
  const uB = await tempAgent(t, tagB);
  const mine = await lead(uA.agent.id, 'COLD');
  const yours = await lead(uB.agent.id, 'COLD');

  // Agent A bulk-marks both IDs — yours should be silently skipped
  const r = await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor,
    agentId: uA.agent.id,
    leadIds: [mine.id, yours.id],
  });
  assert.equal(r.changed, 1);
  assert.equal(r.skipped, 1);

  const yoursAfter = await db.lead.findUnique({ where: { id: yours.id } });
  assert.equal(yoursAfter.status, 'COLD', 'cross-agent lead untouched');
});

test('bulkMarkLeadsLost: writes one audit row per flipped lead', async (t) => {
  const tag = makeTag('s186-audit');
  const u = await tempAgent(t, tag);
  const a = await lead(u.agent.id, 'COLD', 'X');
  const b = await lead(u.agent.id, 'WARM', 'Y');

  await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor,
    agentId: u.agent.id, leadIds: [a.id, b.id],
  });
  const audits = await db.auditLog.findMany({
    where: { entity: 'Lead', entityId: { in: [a.id, b.id] }, action: 'UPDATE' },
  });
  assert.equal(audits.length, 2, 'one audit per flipped row');
  assert.equal(audits[0].after.bulkMarkLost, true);
});

test('bulkMarkLeadsLost: caps payload at 500 ids', async () => {
  const oversized = Array.from({ length: 600 }, (_, i) => `fake-${i}`);
  const r = await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor, agentId: 'nope',
    leadIds: oversized,
  });
  // None match (fake ids) but the cap should engage: total reports the
  // capped count, not 600.
  assert.equal(r.total, 500, 'payload capped to 500');
  assert.equal(r.changed, 0);
});

test('bulkMarkLeadsLost: soft-deleted leads excluded', async (t) => {
  const tag = makeTag('s186-soft');
  const u = await tempAgent(t, tag);
  const live = await lead(u.agent.id, 'COLD');
  const archived = await lead(u.agent.id, 'COLD');
  await db.lead.update({ where: { id: archived.id }, data: { deletedAt: new Date() } });

  const r = await bulkMarkLeadsLost({
    req: fakeReq, actor: systemActor,
    agentId: u.agent.id, leadIds: [live.id, archived.id],
  });
  assert.equal(r.changed, 1, 'only live lead flipped');
});
