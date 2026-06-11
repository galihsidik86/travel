// Stage 188 — AGEN tier filter on /admin/users list.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { listUsers, AGENT_TIERS } from '../src/services/userAdmin.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, { tier = 'BRONZE' } = {}) {
  const email = `${tag}-${tier.toLowerCase()}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag} ${tier}`, phone: '+62811',
      agent: {
        create: {
          displayName: `Agen ${tier}`, slug: `${tag}-${tier.toLowerCase()}`,
          tier, whatsapp: '+62811',
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('exported AGENT_TIERS list matches canonical 4', () => {
  assert.deepEqual(AGENT_TIERS, ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']);
});

test('listUsers: tier=ALL → no filter applied', async (t) => {
  const tag = makeTag('s188-all');
  await tempAgent(t, tag, { tier: 'BRONZE' });
  await tempAgent(t, tag, { tier: 'GOLD' });
  const rows = await listUsers({ search: tag, tier: 'ALL' });
  const tiers = rows.map((r) => r.agent?.tier);
  assert.ok(tiers.includes('BRONZE'));
  assert.ok(tiers.includes('GOLD'));
});

test('listUsers: tier=GOLD narrows to gold-only', async (t) => {
  const tag = makeTag('s188-gold');
  await tempAgent(t, tag, { tier: 'BRONZE' });
  const goldUser = await tempAgent(t, tag, { tier: 'GOLD' });
  const rows = await listUsers({ search: tag, tier: 'GOLD' });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(goldUser.id));
  assert.equal(rows.length, 1, 'only GOLD agent returned');
});

test('listUsers: tier filter implicitly narrows role to AGEN', async (t) => {
  const tag = makeTag('s188-role');
  await tempAgent(t, tag, { tier: 'PLATINUM' });
  // Also create a JEMAAH with similar tag — should NOT appear
  const jemaah = await db.user.create({
    data: {
      email: `${tag}-jemaah@example.test`,
      passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `Jemaah ${tag}`, phone: '+62811',
    },
  });
  t.after(async () => { await db.user.deleteMany({ where: { id: jemaah.id } }); });

  const rows = await listUsers({ search: tag, tier: 'PLATINUM' });
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(jemaah.id), 'JEMAAH not in tier-filtered results');
  assert.equal(rows[0].role, 'AGEN');
});

test('listUsers: tier filter case-insensitive', async (t) => {
  const tag = makeTag('s188-case');
  const agent = await tempAgent(t, tag, { tier: 'SILVER' });
  // Pass lowercase tier
  const rows = await listUsers({ search: tag, tier: 'silver' });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(agent.id), 'lowercase tier normalised');
});

test('listUsers: unknown tier still filters (no canonical-validation)', async (t) => {
  const tag = makeTag('s188-unknown');
  await tempAgent(t, tag, { tier: 'BRONZE' });
  // Future tier "DIAMOND" — no rows match
  const rows = await listUsers({ search: tag, tier: 'DIAMOND' });
  assert.equal(rows.length, 0, 'no rows match unknown tier');
});
