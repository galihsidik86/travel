// Stage 267 — agent CRM "Hari ini" widget.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAgentTodayLeads } from '../src/services/agentTodayLeads.js';

async function makeAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-tl@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+6281100001',
    },
  });
  const profile = await db.agentProfile.create({
    data: { userId: user.id, slug: tag, displayName: `Agen ${tag}`, whatsapp: '+6281100001' },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: profile.id } });
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { profile };
}

async function makeLead(agentId, { fullName = 'Test', followUpAt = null, status = 'COLD', snoozedUntilAt = null } = {}) {
  return db.lead.create({
    data: {
      agentId, fullName, phone: '+6281200001', status,
      followUpAt, snoozedUntilAt,
    },
  });
}

test('getAgentTodayLeads: empty agentId returns empty', async () => {
  const r = await getAgentTodayLeads({ agentId: '' });
  assert.deepEqual(r, { overdue: [], today: [], total: 0 });
});

test('getAgentTodayLeads: surfaces overdue + today, excludes future', async (t) => {
  const { profile } = await makeAgent(t, makeTag('atl-mix'));
  const now = new Date('2026-06-15T10:00:00');
  // Overdue: 3 days ago
  const overdueDate = new Date(now); overdueDate.setDate(overdueDate.getDate() - 3);
  // Today: 8 hours later
  const todayDate = new Date(now); todayDate.setHours(18, 0, 0, 0);
  // Future: 5 days out
  const futureDate = new Date(now); futureDate.setDate(futureDate.getDate() + 5);
  const overdue = await makeLead(profile.id, { fullName: 'Overdue', followUpAt: overdueDate });
  const today = await makeLead(profile.id, { fullName: 'Today', followUpAt: todayDate });
  const future = await makeLead(profile.id, { fullName: 'Future', followUpAt: futureDate });
  const r = await getAgentTodayLeads({ agentId: profile.id, now });
  assert.equal(r.overdue.length, 1);
  assert.equal(r.today.length, 1);
  assert.equal(r.total, 2);
  assert.equal(r.overdue[0].id, overdue.id);
  assert.equal(r.today[0].id, today.id);
  // Future explicitly NOT present
  const allIds = [...r.overdue, ...r.today].map((l) => l.id);
  assert.ok(!allIds.includes(future.id));
});

test('getAgentTodayLeads: leads without followUpAt do not surface', async (t) => {
  const { profile } = await makeAgent(t, makeTag('atl-nofu'));
  await makeLead(profile.id, { fullName: 'No FU' });
  const r = await getAgentTodayLeads({ agentId: profile.id });
  assert.equal(r.total, 0);
});

test('getAgentTodayLeads: snoozed leads excluded', async (t) => {
  const { profile } = await makeAgent(t, makeTag('atl-snz'));
  const now = new Date('2026-06-15T10:00:00');
  const overdueDate = new Date(now); overdueDate.setDate(overdueDate.getDate() - 3);
  // Same lead has overdue followUpAt AND a snooze 1 day in the future
  const snoozeFuture = new Date(now); snoozeFuture.setDate(snoozeFuture.getDate() + 1);
  await makeLead(profile.id, {
    fullName: 'Snoozed Overdue',
    followUpAt: overdueDate,
    snoozedUntilAt: snoozeFuture,
  });
  const r = await getAgentTodayLeads({ agentId: profile.id, now });
  assert.equal(r.total, 0, 'snoozed lead invisible even if overdue');
});

test('getAgentTodayLeads: CONVERTED/LOST leads excluded', async (t) => {
  const { profile } = await makeAgent(t, makeTag('atl-trm'));
  const now = new Date('2026-06-15T10:00:00');
  const overdueDate = new Date(now); overdueDate.setDate(overdueDate.getDate() - 3);
  await makeLead(profile.id, { fullName: 'Lost', status: 'LOST', followUpAt: overdueDate });
  await makeLead(profile.id, { fullName: 'Converted', status: 'CONVERTED', followUpAt: overdueDate });
  const r = await getAgentTodayLeads({ agentId: profile.id, now });
  assert.equal(r.total, 0);
});

test('getAgentTodayLeads: overdue sorted oldest-first', async (t) => {
  const { profile } = await makeAgent(t, makeTag('atl-srt'));
  const now = new Date('2026-06-15T10:00:00');
  const d3 = new Date(now); d3.setDate(d3.getDate() - 3);
  const d10 = new Date(now); d10.setDate(d10.getDate() - 10);
  const d1 = new Date(now); d1.setDate(d1.getDate() - 1);
  await makeLead(profile.id, { fullName: 'D3', followUpAt: d3 });
  await makeLead(profile.id, { fullName: 'D10', followUpAt: d10 });
  await makeLead(profile.id, { fullName: 'D1', followUpAt: d1 });
  const r = await getAgentTodayLeads({ agentId: profile.id, now });
  assert.equal(r.overdue.length, 3);
  // Oldest first → D10, D3, D1
  assert.equal(r.overdue[0].fullName, 'D10');
  assert.equal(r.overdue[2].fullName, 'D1');
});
