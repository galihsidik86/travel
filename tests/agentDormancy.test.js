// Stage 185 — daily scan flags ACTIVE agents with no booking + no
// lead activity in last 60d as dormant. Auto-clears when activity resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { scanAgentDormancy, DEFAULT_INACTIVE_DAYS } from '../src/services/agentDormancy.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, { status = 'ACTIVE', dormantSince = null } = {}) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      status,
      agent: {
        create: {
          displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE',
          whatsapp: '+62811', dormantSince,
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'AgentProfile', entityId: user.agent.id } });
    await db.lead.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('exported DEFAULT_INACTIVE_DAYS sane', () => {
  assert.equal(DEFAULT_INACTIVE_DAYS, 60);
});

test('scanAgentDormancy: flags ACTIVE agent with no activity', async (t) => {
  const tag = makeTag('s185-flag');
  const u = await tempAgent(t, tag);
  const r = await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  assert.ok(after.dormantSince instanceof Date, 'dormantSince stamped');
  assert.ok(r.flaggedNew >= 1);

  const audit = await db.auditLog.findFirst({
    where: { entity: 'AgentProfile', entityId: u.agent.id, action: 'UPDATE' },
  });
  assert.equal(audit.before.dormantSince, null);
  assert.equal(audit.after.dormancyScan, true);
});

test('scanAgentDormancy: clears dormancy when fresh activity resumes', async (t) => {
  const tag = makeTag('s185-clear');
  const u = await tempAgent(t, tag, { dormantSince: new Date('2025-01-01') });
  // Fresh lead within window
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'Fresh', phone: '0811', status: 'WARM', source: 'WA' },
  });

  const r = await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  assert.equal(after.dormantSince, null, 'dormancy cleared');
  assert.ok(r.cleared >= 1);
});

test('scanAgentDormancy: does NOT flag agent with recent booking', async (t) => {
  const tag = makeTag('s185-active');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // Booking via this agent within window
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { agentId: u.agent.id } });

  await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  assert.equal(after.dormantSince, null, 'recent booking → not dormant');
});

test('scanAgentDormancy: does NOT flag agent with recent lead', async (t) => {
  const tag = makeTag('s185-lead');
  const u = await tempAgent(t, tag);
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'L', phone: '0811', status: 'COLD', source: 'WA' },
  });
  await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  assert.equal(after.dormantSince, null);
});

test('scanAgentDormancy: SUSPENDED user excluded from scan', async (t) => {
  const tag = makeTag('s185-susp');
  const u = await tempAgent(t, tag, { status: 'SUSPENDED' });
  const r = await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  // SUSPENDED agent not scanned → dormantSince stays null
  assert.equal(after.dormantSince, null);
});

test('scanAgentDormancy: idempotent on already-dormant + no activity', async (t) => {
  const tag = makeTag('s185-idem');
  const u = await tempAgent(t, tag, { dormantSince: new Date('2025-01-01') });
  const r = await scanAgentDormancy({});
  const after = await db.agentProfile.findUnique({
    where: { id: u.agent.id }, select: { dormantSince: true },
  });
  // Still dormant, no extra stamp
  assert.equal(after.dormantSince.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.ok(r.stayedDormant >= 1);
});
