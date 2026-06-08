// Stage 46 — stalled-leads digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser } from './_helpers.js';
import { getStalledLeadsForAgent, listActiveAgentsForLeadsDigest } from '../src/services/stalledLeadsDigest.js';
import { notifyStalledLeads } from '../src/services/notifications.js';

const ONE_DAY_MS = 86_400_000;

async function tempAgent(t, tag, { status = 'ACTIVE' } = {}) {
  const user = await tempUser(t, tag, { role: 'AGEN', status });
  const agent = await db.agentProfile.create({
    data: { userId: user.id, slug: `${tag}-slug`, displayName: `Agent ${tag}`, whatsapp: '+62811' },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: agent.id } });
    await db.agentProfile.deleteMany({ where: { id: agent.id } });
  });
  return { user, agent };
}

test('returns null for unknown agentId', async () => {
  assert.equal(await getStalledLeadsForAgent({ agentId: undefined }), null);
});

test('fresh leads (updated <7d ago) excluded; stale (>=7d) included', async (t) => {
  const tag = makeTag('sl-fresh');
  const { agent } = await tempAgent(t, tag);

  const fresh = await db.lead.create({
    data: {
      agentId: agent.id, fullName: 'Fresh Friend', phone: `0888-${tag}-f`,
      status: 'WARM', source: 'IG',
    },
  });
  // updatedAt is auto-set to now; force into past for "stale"
  const stale = await db.lead.create({
    data: {
      agentId: agent.id, fullName: 'Stale Stuart', phone: `0888-${tag}-s`,
      status: 'WARM', source: 'WA',
    },
  });
  await db.lead.update({
    where: { id: stale.id },
    data: { updatedAt: new Date(Date.now() - 10 * ONE_DAY_MS) },
  });

  const digest = await getStalledLeadsForAgent({ agentId: agent.id });
  const ids = digest.rows.map((r) => r.id);
  assert.ok(!ids.includes(fresh.id), 'fresh lead must NOT appear');
  assert.ok(ids.includes(stale.id), 'stale lead must appear');
  const stalled = digest.rows.find((r) => r.id === stale.id);
  assert.ok(stalled.stalledDays >= 10);
});

test('CONVERTED + LOST leads always excluded regardless of age', async (t) => {
  const tag = makeTag('sl-terminal');
  const { agent } = await tempAgent(t, tag);

  const converted = await db.lead.create({
    data: {
      agentId: agent.id, fullName: 'Converted Carl', phone: `0888-${tag}-c`,
      status: 'CONVERTED', source: 'IG',
    },
  });
  await db.lead.update({
    where: { id: converted.id },
    data: { updatedAt: new Date(Date.now() - 30 * ONE_DAY_MS) },
  });
  const lost = await db.lead.create({
    data: {
      agentId: agent.id, fullName: 'Lost Lily', phone: `0888-${tag}-l`,
      status: 'LOST',
    },
  });
  await db.lead.update({
    where: { id: lost.id },
    data: { updatedAt: new Date(Date.now() - 30 * ONE_DAY_MS) },
  });

  const digest = await getStalledLeadsForAgent({ agentId: agent.id });
  const ids = digest.rows.map((r) => r.id);
  assert.ok(!ids.includes(converted.id), 'CONVERTED must be excluded');
  assert.ok(!ids.includes(lost.id), 'LOST must be excluded');
});

test('sort: most-stalled lead lands first', async (t) => {
  const tag = makeTag('sl-sort');
  const { agent } = await tempAgent(t, tag);

  const newer = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Newer N', phone: `0888-${tag}-n`, status: 'COLD' },
  });
  await db.lead.update({
    where: { id: newer.id },
    data: { updatedAt: new Date(Date.now() - 8 * ONE_DAY_MS) },
  });
  const older = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Older O', phone: `0888-${tag}-o`, status: 'COLD' },
  });
  await db.lead.update({
    where: { id: older.id },
    data: { updatedAt: new Date(Date.now() - 40 * ONE_DAY_MS) },
  });

  const digest = await getStalledLeadsForAgent({ agentId: agent.id });
  const ours = digest.rows.filter((r) => r.id === newer.id || r.id === older.id);
  assert.equal(ours.length, 2);
  assert.equal(ours[0].id, older.id, 'older stalled lead must come first');
  assert.equal(ours[1].id, newer.id);
});

test('staleDays param respected (1d window catches fresher leads)', async (t) => {
  const tag = makeTag('sl-window');
  const { agent } = await tempAgent(t, tag);
  const mid = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Mid Mike', phone: `0888-${tag}-m`, status: 'WARM' },
  });
  await db.lead.update({
    where: { id: mid.id },
    data: { updatedAt: new Date(Date.now() - 3 * ONE_DAY_MS) },
  });

  const wide = await getStalledLeadsForAgent({ agentId: agent.id, staleDays: 1 });
  assert.ok(wide.rows.some((r) => r.id === mid.id), '1d window must catch the 3-day lead');
  const narrow = await getStalledLeadsForAgent({ agentId: agent.id, staleDays: 7 });
  assert.ok(!narrow.rows.some((r) => r.id === mid.id), '7d window must skip the 3-day lead');
});

test('notifyStalledLeads silent when digest empty', async (t) => {
  const tag = makeTag('sl-empty');
  const { agent, user } = await tempAgent(t, tag);
  const r = await notifyStalledLeads({ agent: { ...agent, user }, digest: { rows: [], counts: { total: 0, warm: 0, cold: 0 }, staleDays: 7 } });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyStalledLeads enqueues 1 EMAIL with lead names in body', async (t) => {
  const tag = makeTag('sl-fan');
  const { agent, user } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Listed Larry', phone: `0888-${tag}-l`, status: 'WARM' },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: { updatedAt: new Date(Date.now() - 14 * ONE_DAY_MS) },
  });
  const digest = await getStalledLeadsForAgent({ agentId: agent.id });
  const r = await notifyStalledLeads({ agent: { ...agent, user }, digest });
  assert.equal(r.enqueued, 1);

  const row = await db.notification.findFirst({
    where: { type: 'AGENT_STALLED_LEADS', recipientEmail: user.email },
    select: { body: true, subject: true },
  });
  assert.ok(row);
  assert.match(row.body, /Listed Larry/);
  await db.notification.deleteMany({
    where: { type: 'AGENT_STALLED_LEADS', recipientEmail: user.email },
  });
});

test('listActiveAgentsForLeadsDigest filters suspended', async (t) => {
  const tag = makeTag('sl-list');
  const { agent: active } = await tempAgent(t, tag);
  const { agent: suspended } = await tempAgent(t, `${tag}-sus`, { status: 'SUSPENDED' });

  const list = await listActiveAgentsForLeadsDigest();
  assert.ok(list.some((a) => a.id === active.id));
  assert.ok(!list.some((a) => a.id === suspended.id));
});
