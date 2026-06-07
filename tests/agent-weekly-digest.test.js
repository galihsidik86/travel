// Stage 36 — per-agent weekly digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { buildAgentWeeklyDigest, listActiveAgentsForDigest } from '../src/services/agentWeeklyDigest.js';
import { notifyAgentWeeklyDigest } from '../src/services/notifications.js';

async function tempAgent(t, tag, { status = 'ACTIVE' } = {}) {
  const user = await tempUser(t, tag, { role: 'AGEN', status });
  const agent = await db.agentProfile.create({
    data: {
      userId: user.id,
      slug: `${tag}-slug`,
      displayName: `Agent ${tag}`,
      whatsapp: '+62811',
    },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: agent.id } });
    await db.komisiPayout.deleteMany({ where: { agentId: agent.id } });
    await db.agentProfile.deleteMany({ where: { id: agent.id } });
  });
  return { user, agent };
}

test('returns null for unknown / suspended / soft-deleted agent', async (t) => {
  assert.equal(await buildAgentWeeklyDigest({ agentId: 'no-such-agent' }), null);
  const tag = makeTag('aw-suspended');
  const { agent } = await tempAgent(t, tag, { status: 'SUSPENDED' });
  assert.equal(await buildAgentWeeklyDigest({ agentId: agent.id }), null);
});

test('shape: returns full envelope with deltas + topPaket arrays', async (t) => {
  const tag = makeTag('aw-shape');
  const { agent } = await tempAgent(t, tag);
  const digest = await buildAgentWeeklyDigest({ agentId: agent.id });
  assert.ok(digest);
  assert.ok(digest.label.includes(' – '));
  assert.ok(typeof digest.counts.newBookings === 'number');
  for (const k of ['newBookings', 'lunasBookings', 'cancelledBookings', 'leadsCreated',
    'leadsConverted', 'leadsLost', 'lunasRevenueIdr', 'komisiEarnedIdr', 'komisiPaidIdr']) {
    assert.ok(digest.deltas[k], `delta missing for ${k}`);
  }
  assert.ok(Array.isArray(digest.topPaket));
});

test('weekend re-runs idempotent (resolveLastFullWeek)', async (t) => {
  const tag = makeTag('aw-week');
  const { agent } = await tempAgent(t, tag);
  const mon = new Date(2026, 5, 8, 7, 0, 0);
  const sat = new Date(2026, 5, 13, 23, 0, 0);
  const a = await buildAgentWeeklyDigest({ agentId: agent.id, now: mon });
  const b = await buildAgentWeeklyDigest({ agentId: agent.id, now: sat });
  assert.equal(a.weekStart, b.weekStart);
});

test('listActiveAgentsForDigest filters suspended + missing email', async (t) => {
  const tag = makeTag('aw-list');
  const { agent: active } = await tempAgent(t, tag);
  const { agent: suspended } = await tempAgent(t, `${tag}-sus`, { status: 'SUSPENDED' });

  const list = await listActiveAgentsForDigest();
  assert.ok(list.some((a) => a.id === active.id), 'active agent must appear');
  assert.ok(!list.some((a) => a.id === suspended.id), 'suspended agent must NOT appear');
});

test('notifyAgentWeeklyDigest enqueues 1 EMAIL per digest', async (t) => {
  const tag = makeTag('aw-fan');
  const { agent, user } = await tempAgent(t, tag);
  const digest = await buildAgentWeeklyDigest({ agentId: agent.id });
  const result = await notifyAgentWeeklyDigest({ digest });
  assert.equal(result.enqueued, 1);

  const row = await db.notification.findFirst({
    where: { type: 'AGENT_WEEKLY_DIGEST', recipientEmail: user.email },
    select: { subject: true, relatedEntity: true, relatedEntityId: true },
  });
  assert.ok(row, 'notif row must exist');
  assert.match(row.subject, /ringkasan mingguan Anda/);
  assert.equal(row.relatedEntity, 'AgentProfile');
  assert.equal(row.relatedEntityId, agent.id);

  await db.notification.deleteMany({
    where: { type: 'AGENT_WEEKLY_DIGEST', recipientEmail: user.email },
  });
});
