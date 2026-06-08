// Stage 57 — auto-archive stale leads via prune.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser } from './_helpers.js';
import { pruneRetentionWindows } from '../src/services/retention.js';

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

test('COLD lead untouched >180d gets soft-deleted', async (t) => {
  const tag = makeTag('arch-cold');
  const { agent } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Stale C', phone: `0888-${tag}-c`, status: 'COLD' },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: { updatedAt: new Date(Date.now() - 200 * ONE_DAY_MS) },
  });

  await pruneRetentionWindows({});
  const re = await db.lead.findUnique({
    where: { id: lead.id },
    select: { deletedAt: true },
  });
  assert.ok(re.deletedAt, 'COLD lead >180d must be soft-deleted (deletedAt set)');
});

test('LOST lead untouched >180d also archived', async (t) => {
  const tag = makeTag('arch-lost');
  const { agent } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Stale L', phone: `0888-${tag}-l`, status: 'LOST' },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: { updatedAt: new Date(Date.now() - 200 * ONE_DAY_MS) },
  });

  await pruneRetentionWindows({});
  const re = await db.lead.findUnique({
    where: { id: lead.id },
    select: { deletedAt: true },
  });
  assert.ok(re.deletedAt, 'LOST lead >180d must be soft-deleted');
});

test('WARM lead NEVER archived (even when stale)', async (t) => {
  const tag = makeTag('arch-warm');
  const { agent } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Warm W', phone: `0888-${tag}-w`, status: 'WARM' },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: { updatedAt: new Date(Date.now() - 300 * ONE_DAY_MS) },
  });

  await pruneRetentionWindows({});
  const re = await db.lead.findUnique({
    where: { id: lead.id },
    select: { deletedAt: true },
  });
  assert.equal(re.deletedAt, null, 'WARM lead must NOT be archived (still workable)');
});

test('CONVERTED lead NEVER archived (booking history)', async (t) => {
  const tag = makeTag('arch-conv');
  const { agent } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Conv', phone: `0888-${tag}-cv`, status: 'CONVERTED' },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: { updatedAt: new Date(Date.now() - 300 * ONE_DAY_MS) },
  });

  await pruneRetentionWindows({});
  const re = await db.lead.findUnique({
    where: { id: lead.id },
    select: { deletedAt: true },
  });
  assert.equal(re.deletedAt, null, 'CONVERTED lead must be kept (booking history)');
});

test('Fresh COLD lead (<180d) NOT archived', async (t) => {
  const tag = makeTag('arch-fresh');
  const { agent } = await tempAgent(t, tag);
  const lead = await db.lead.create({
    data: { agentId: agent.id, fullName: 'Fresh', phone: `0888-${tag}-f`, status: 'COLD' },
  });
  // updatedAt = now (default) — definitely <180d
  await pruneRetentionWindows({});
  const re = await db.lead.findUnique({
    where: { id: lead.id },
    select: { deletedAt: true },
  });
  assert.equal(re.deletedAt, null, 'fresh COLD lead must NOT be archived');
});

test('pruneRetentionWindows returns staleLeads.archived count', async (t) => {
  const tag = makeTag('arch-count');
  const { agent } = await tempAgent(t, tag);
  // Three stale COLD leads
  for (let i = 0; i < 3; i++) {
    const lead = await db.lead.create({
      data: { agentId: agent.id, fullName: `S${i}`, phone: `0888-${tag}-${i}`, status: 'COLD' },
    });
    await db.lead.update({
      where: { id: lead.id },
      data: { updatedAt: new Date(Date.now() - 200 * ONE_DAY_MS) },
    });
  }
  const out = await pruneRetentionWindows({});
  assert.ok(out.staleLeads, 'result must include staleLeads bucket');
  assert.ok(out.staleLeads.archived >= 3);
});
