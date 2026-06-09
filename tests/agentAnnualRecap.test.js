// Stage 158 — yearly Jan 5 recap email of last year's komisi
// statements per agent. Silent when no statements exist for the year.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import {
  buildAgentAnnualRecap, listAgentsWithStatementsForYear,
  sendAgentAnnualRecaps, previousYear,
} from '../src/services/agentAnnualRecap.js';
import { notifyAgentAnnualRecap } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, { notifKomisiStatement = true, status = 'ACTIVE' } = {}) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811', status,
      agent: {
        create: {
          displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE',
          whatsapp: '+62811', notifKomisiStatement,
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function seedStatement(agentId, periodYM, earned, paid, lineCount = 1) {
  return db.komisiStatement.create({
    data: {
      agentId, periodYM,
      totalEarnedIdr: earned, totalPaidIdr: paid, lineCount,
    },
  });
}

test('previousYear: returns prior calendar year', () => {
  assert.equal(previousYear(new Date('2026-01-05')), 2025);
  assert.equal(previousYear(new Date('2026-12-31')), 2025);
});

test('buildAgentAnnualRecap: aggregates totals across all months in year', async (t) => {
  const tag = makeTag('s158-totals');
  const agentUser = await tempAgent(t, tag);
  await seedStatement(agentUser.agent.id, '2025-01', 100_000, 50_000, 2);
  await seedStatement(agentUser.agent.id, '2025-05', 200_000, 100_000, 3);
  await seedStatement(agentUser.agent.id, '2024-12', 999_000, 999_000, 99);  // out of scope

  const r = await buildAgentAnnualRecap({ agentId: agentUser.agent.id, year: 2025 });
  assert.ok(r);
  assert.equal(r.totals.earnedIdr, 300_000);
  assert.equal(r.totals.paidIdr, 150_000);
  assert.equal(r.totals.statementCount, 2);
  assert.equal(r.totals.lineCount, 5);
  // Ascending order — Jan first
  assert.equal(r.statements[0].periodYM, '2025-01');
  assert.equal(r.statements[1].periodYM, '2025-05');
});

test('buildAgentAnnualRecap: empty year → null (no recap)', async (t) => {
  const tag = makeTag('s158-empty');
  const agentUser = await tempAgent(t, tag);
  const r = await buildAgentAnnualRecap({ agentId: agentUser.agent.id, year: 2025 });
  assert.equal(r, null);
});

test('notifyAgentAnnualRecap: skipped reasons cover key cases', async () => {
  // no_email
  const r1 = await notifyAgentAnnualRecap({
    recap: { year: 2025, statements: [], totals: { earnedIdr: 1, paidIdr: 0, lineCount: 1, statementCount: 1 } },
    agent: { displayName: 'A', slug: 'a', email: null, userId: null, notifKomisiStatement: true },
  });
  assert.equal(r1.skipped, true);
  assert.equal(r1.reason, 'no_email');

  // no_statements
  const r2 = await notifyAgentAnnualRecap({
    recap: { year: 2025, statements: [], totals: { earnedIdr: 0, paidIdr: 0, lineCount: 0, statementCount: 0 } },
    agent: { displayName: 'A', slug: 'a', email: 'x@y.test', userId: null, notifKomisiStatement: true },
  });
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'no_statements');

  // opted_out
  const r3 = await notifyAgentAnnualRecap({
    recap: { year: 2025, statements: [], totals: { earnedIdr: 1, paidIdr: 0, lineCount: 1, statementCount: 1 } },
    agent: { displayName: 'A', slug: 'a', email: 'x@y.test', userId: null, notifKomisiStatement: false },
  });
  assert.equal(r3.skipped, true);
  assert.equal(r3.reason, 'opted_out');
});

test('notifyAgentAnnualRecap: enqueues EMAIL with month breakdown', async (t) => {
  const tag = makeTag('s158-fire');
  const agentUser = await tempAgent(t, tag);
  const s1 = await seedStatement(agentUser.agent.id, '2025-03', 100_000, 0, 2);
  const s2 = await seedStatement(agentUser.agent.id, '2025-07', 200_000, 100_000, 3);

  const recap = await buildAgentAnnualRecap({ agentId: agentUser.agent.id, year: 2025 });
  const r = await notifyAgentAnnualRecap({
    recap,
    agent: {
      id: agentUser.agent.id, slug: tag, displayName: 'Test',
      email: agentUser.email, userId: agentUser.id,
      notifKomisiStatement: true,
    },
  });
  assert.equal(r.enqueued, 1);
  t.after(() => db.notification.deleteMany({ where: { recipientUserId: agentUser.id } }));

  const rows = await db.notification.findMany({
    where: { type: 'AGENT_ANNUAL_RECAP', recipientUserId: agentUser.id },
  });
  assert.equal(rows.length, 1);
  // Body should mention both periods
  assert.match(rows[0].body, /2025-03/);
  assert.match(rows[0].body, /2025-07/);
  assert.match(rows[0].subject, /2025/);
});

test('sendAgentAnnualRecaps: batches across agents + counts skips', async (t) => {
  const tag = makeTag('s158-batch');
  const agentA = await tempAgent(t, `${tag}-a`);
  const agentB = await tempAgent(t, `${tag}-b`, { notifKomisiStatement: false });

  await seedStatement(agentA.agent.id, '2025-06', 100_000, 0, 2);
  await seedStatement(agentB.agent.id, '2025-06', 200_000, 0, 3);
  t.after(() => db.notification.deleteMany({
    where: { recipientUserId: { in: [agentA.id, agentB.id] } },
  }));

  const r = await sendAgentAnnualRecaps({ year: 2025 });
  // A enqueued, B skipped (opted out)
  assert.ok(r.enqueued >= 1);
  assert.ok(r.skipped >= 1);
  assert.equal(r.errors, 0);
});

test('listAgentsWithStatementsForYear: excludes suspended agents', async (t) => {
  const tag = makeTag('s158-suspended');
  const agent = await tempAgent(t, tag, { status: 'SUSPENDED' });
  await seedStatement(agent.agent.id, '2025-06', 100, 0, 1);

  const agents = await listAgentsWithStatementsForYear({ year: 2025 });
  const ours = agents.find((a) => a.slug === tag);
  assert.equal(ours, undefined, 'suspended agent excluded');
});
