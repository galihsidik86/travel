// Stage 163 — daily WA nudge to agents who haven't opened recent komisi
// statements. Per-agent 14-day cooldown via the Notification table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { generateAgentStatement } from '../src/services/komisiStatement.js';
import {
  getUnreadStatementCandidates, sendStatementUnreadNudges,
  DEFAULT_COOLDOWN_DAYS, DEFAULT_WINDOW_MONTHS,
} from '../src/services/statementUnreadNudge.js';
import { notifyStatementUnreadNudge } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, {
  status = 'ACTIVE',
  notifKomisiStatement = true,
  whatsapp = '+62811',
} = {}) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811', status,
      agent: {
        create: {
          displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE',
          whatsapp, notifKomisiStatement,
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.auditLog.deleteMany({ where: { entity: 'KomisiStatement' } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function seedUnreadStatement(t, agentUser, periodYM = '2026-05', tag = 's163') {
  const paket = await tempPaket(t, makeTag(`${tag}-p`));
  const jem = await tempJemaah(t, makeTag(`${tag}-j`));
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '200000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date(`${periodYM}-15`),
    },
  });
  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });
  return r.statement;
}

test('notifyStatementUnreadNudge: skip when agent has no WhatsApp', async () => {
  const r = await notifyStatementUnreadNudge({
    agent: { displayName: 'X', slug: 'x', whatsapp: null, userId: null, id: 'x' },
    unreadCount: 1, oldestPeriod: '2026-05',
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_phone');
});

test('notifyStatementUnreadNudge: skip when agent opted out', async () => {
  const r = await notifyStatementUnreadNudge({
    agent: {
      displayName: 'X', slug: 'x', whatsapp: '+62811',
      notifKomisiStatement: false, userId: null, id: 'x',
    },
    unreadCount: 1, oldestPeriod: '2026-05',
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'opted_out');
});

test('getUnreadStatementCandidates: picks agents with agentDownloadCount=0 recent statements', async (t) => {
  const tag = makeTag('s163-pick');
  const agentUser = await tempAgent(t, tag);
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.ok(mine, 'candidate found');
  assert.equal(mine.unreadCount, 1);
  assert.equal(mine.oldestUnreadPeriod, '2026-05');
});

test('getUnreadStatementCandidates: excludes opted-out agents', async (t) => {
  const tag = makeTag('s163-optout');
  const agentUser = await tempAgent(t, tag, { notifKomisiStatement: false });
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.equal(mine, undefined, 'opted-out agent skipped');
});

test('getUnreadStatementCandidates: excludes suspended agents', async (t) => {
  const tag = makeTag('s163-susp');
  const agentUser = await tempAgent(t, tag, { status: 'SUSPENDED' });
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.equal(mine, undefined, 'suspended agent skipped');
});

test('getUnreadStatementCandidates: skips zero-line statements', async (t) => {
  const tag = makeTag('s163-zero');
  const agentUser = await tempAgent(t, tag);
  // Direct insert — generateAgentStatement with zero komisi yields lineCount=0
  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now });
  const mine = rows.find((r2) => r2.agent.id === agentUser.agent.id);
  assert.equal(mine, undefined, 'zero-line statement does not nudge');
});

test('getUnreadStatementCandidates: applies cooldown — excludes recently-nudged agent', async (t) => {
  const tag = makeTag('s163-cool');
  const agentUser = await tempAgent(t, tag);
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  // Drop a recent STATEMENT_UNREAD_NUDGE row → should be filtered out
  await db.notification.create({
    data: {
      type: 'STATEMENT_UNREAD_NUDGE', channel: 'WA', status: 'SENT',
      recipientUserId: agentUser.id, recipientPhone: '+62811',
      body: 'prior nudge', sentAt: new Date('2026-06-05'),
    },
  });

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now, cooldownDays: 14 });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.equal(mine, undefined, 'recently-nudged agent excluded');
});

test('getUnreadStatementCandidates: nudge older than cooldown → candidate re-emerges', async (t) => {
  const tag = makeTag('s163-old');
  const agentUser = await tempAgent(t, tag);
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  // Old nudge — beyond cooldown
  await db.notification.create({
    data: {
      type: 'STATEMENT_UNREAD_NUDGE', channel: 'WA', status: 'SENT',
      recipientUserId: agentUser.id, recipientPhone: '+62811',
      body: 'old nudge', sentAt: new Date('2026-04-01'),
      createdAt: new Date('2026-04-01'),
    },
  });

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now, cooldownDays: 14 });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.ok(mine, 'old nudge does not block — candidate re-emerges');
});

test('getUnreadStatementCandidates: excludes opened (downloaded) statements', async (t) => {
  const tag = makeTag('s163-opened');
  const agentUser = await tempAgent(t, tag);
  const stmt = await seedUnreadStatement(t, agentUser, '2026-05', tag);

  // Simulate agent download → counter > 0
  await db.komisiStatement.update({
    where: { id: stmt.id },
    data: { agentDownloadCount: 1, agentLastDownloadAt: new Date() },
  });

  const now = new Date('2026-06-10');
  const { rows } = await getUnreadStatementCandidates({ now });
  const mine = rows.find((r) => r.agent.id === agentUser.agent.id);
  assert.equal(mine, undefined, 'opened statement no longer triggers nudge');
});

test('sendStatementUnreadNudges: end-to-end enqueues WA row', async (t) => {
  const tag = makeTag('s163-e2e');
  const agentUser = await tempAgent(t, tag);
  await seedUnreadStatement(t, agentUser, '2026-05', tag);

  const r = await sendStatementUnreadNudges({ now: new Date('2026-06-10') });
  assert.ok(r.enqueued >= 1, 'at least one nudge enqueued');

  const notifs = await db.notification.findMany({
    where: {
      type: 'STATEMENT_UNREAD_NUDGE',
      recipientUserId: agentUser.id,
    },
  });
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].channel, 'WA');
  assert.match(notifs[0].body, /belum dibuka/);
  assert.match(notifs[0].body, /2026-05/);
});

test('sendStatementUnreadNudges: empty candidates → quiet return', async () => {
  // Sentinel `now` far in future where no statements have generatedAt → empty
  const r = await sendStatementUnreadNudges({ now: new Date('2099-01-01') });
  assert.equal(r.agentCount, 0);
  assert.equal(r.enqueued, 0);
});

test('exported constants are sane defaults', () => {
  assert.equal(DEFAULT_COOLDOWN_DAYS, 14);
  assert.equal(DEFAULT_WINDOW_MONTHS, 3);
});
