// Stage 265/266 — lead followUpAt + snoozedUntilAt schema wiring + agen kanban filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { createLead, updateLead } from '../src/services/leads.js';
import { getAgentDashboard } from '../src/services/agenCrm.js';

const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function makeAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-fus@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+6281100002',
    },
  });
  const profile = await db.agentProfile.create({
    data: { userId: user.id, slug: tag, displayName: `Agen ${tag}`, whatsapp: '+6281100002' },
  });
  const actor = { id: user.id, email: user.email, role: 'AGEN' };
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: profile.id } });
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, profile, actor };
}

test('createLead: accepts YYYY-MM-DD for followUpAt', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-cdt'));
  const lead = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: {
      fullName: 'Test Lead', phone: '+6281200001',
      followUpAt: '2026-12-25',
    },
  });
  assert.ok(lead.followUpAt instanceof Date);
  assert.equal(lead.followUpAt.getFullYear(), 2026);
  assert.equal(lead.followUpAt.getMonth(), 11);
  assert.equal(lead.followUpAt.getDate(), 25);
});

test('createLead: accepts YYYY-MM-DD for snoozedUntilAt', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-sdt'));
  const lead = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: {
      fullName: 'Snooze Lead', phone: '+6281200001',
      snoozedUntilAt: '2026-11-01',
    },
  });
  assert.ok(lead.snoozedUntilAt instanceof Date);
  assert.equal(lead.snoozedUntilAt.getFullYear(), 2026);
  assert.equal(lead.snoozedUntilAt.getMonth(), 10);
});

test('createLead: empty followUpAt stays null', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-en'));
  const lead = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'Test', phone: '+6281200001', followUpAt: '' },
  });
  assert.equal(lead.followUpAt, null);
  assert.equal(lead.snoozedUntilAt, null);
});

test('updateLead: clears followUpAt when passed null', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-clr'));
  const created = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'XYZ', phone: '+6281200001', followUpAt: '2026-10-10' },
  });
  assert.ok(created.followUpAt);
  const updated = await updateLead({
    req: fakeReq, actor, agentId: profile.id, leadId: created.id,
    input: { followUpAt: null },
  });
  assert.equal(updated.followUpAt, null);
});

test('updateLead: omitting followUpAt preserves it', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-keep'));
  const created = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'XYZ', phone: '+6281200001', followUpAt: '2026-10-10' },
  });
  // Change only notes; followUpAt should survive
  await updateLead({
    req: fakeReq, actor, agentId: profile.id, leadId: created.id,
    input: { notes: 'edit' },
  });
  const reloaded = await db.lead.findUnique({ where: { id: created.id } });
  assert.ok(reloaded.followUpAt);
});

test('getAgentDashboard kanban: hides snoozed leads (snoozedUntilAt in future)', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-hide'));
  const visible = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'Visible', phone: '+6281100002', status: 'COLD' },
  });
  const snoozed = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'Snoozed', phone: '+6281200001', status: 'COLD' },
  });
  // Set snooze to 7 days in the future
  const future = new Date(Date.now() + 7 * 86400000);
  await db.lead.update({
    where: { id: snoozed.id }, data: { snoozedUntilAt: future },
  });
  const dash = await getAgentDashboard(profile.id, {});
  const ids = dash.pipeline.cold.map((l) => l.id);
  assert.ok(ids.includes(visible.id));
  assert.ok(!ids.includes(snoozed.id), 'snoozed lead hidden from kanban');
});

test('getAgentDashboard kanban: returns snoozed lead after date elapses', async (t) => {
  const { profile, actor } = await makeAgent(t, makeTag('fus-elp'));
  const lead = await createLead({
    req: fakeReq, actor, agentId: profile.id,
    input: { fullName: 'Past', phone: '+6281200001', status: 'COLD' },
  });
  // Snooze date in the past
  const past = new Date(Date.now() - 86400000);
  await db.lead.update({
    where: { id: lead.id }, data: { snoozedUntilAt: past },
  });
  const dash = await getAgentDashboard(profile.id, {});
  const ids = dash.pipeline.cold.map((l) => l.id);
  assert.ok(ids.includes(lead.id), 'elapsed snooze returns to kanban');
});
