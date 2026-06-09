// Stage 157 — per-agent opt-out for the monthly komisi statement
// email. notifyKomisiStatementReady respects AgentProfile.notifKomisiStatement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { generateAgentStatement } from '../src/services/komisiStatement.js';
import { notifyKomisiStatementReady } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag, { notifKomisiStatement = true } = {}) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
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
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.auditLog.deleteMany({ where: { entity: 'KomisiStatement' } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('notifyKomisiStatementReady: opt-out flag → skipped reason opted_out', async () => {
  const r = await notifyKomisiStatementReady({
    statement: { id: 'x', periodYM: '2026-05', totalEarnedIdr: 100, totalPaidIdr: 0, lineCount: 1 },
    agent: { displayName: 'Test', slug: 't', email: 'a@x.test', userId: null,
             notifKomisiStatement: false },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'opted_out');
  assert.equal(r.enqueued, 0);
});

test('notifyKomisiStatementReady: missing flag → defaults to fire (back-compat)', async (t) => {
  const tag = makeTag('s157-default');
  const agentUser = await tempAgent(t, tag);
  const r = await notifyKomisiStatementReady({
    statement: { id: 'fake', periodYM: '2026-05', totalEarnedIdr: 100, totalPaidIdr: 0, lineCount: 1 },
    // agent omits notifKomisiStatement key — legacy callers
    agent: { displayName: 'A', slug: tag, email: agentUser.email, userId: agentUser.id },
  });
  // Should fire (enqueued: 1) since the flag-absent case defaults to send
  assert.equal(r.enqueued, 1);
  t.after(() => db.notification.deleteMany({ where: { recipientUserId: agentUser.id } }));
});

test('generateAgentStatement: opted-out agent → no notif but row + PDF created', async (t) => {
  const tag = makeTag('s157-optedout');
  const agentUser = await tempAgent(t, tag, { notifKomisiStatement: false });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15') },
  });

  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.equal(r.created, true, 'opt-out doesnt block creation — only the email');
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });

  // No notif row landed for our agent
  const notifs = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  assert.equal(notifs, 0);
});

test('generateAgentStatement: opted-IN agent → notif fires as before', async (t) => {
  const tag = makeTag('s157-optin');
  const agentUser = await tempAgent(t, tag, { notifKomisiStatement: true });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-15') },
  });

  const r = await generateAgentStatement({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  t.after(() => { try { if (r.pdfPath) rmSync(r.pdfPath); } catch {} });

  const notifs = await db.notification.count({
    where: { type: 'KOMISI_STATEMENT_READY', recipientUserId: agentUser.id },
  });
  assert.equal(notifs, 1);
});

test('AgentProfile.notifKomisiStatement defaults to true on new rows', async (t) => {
  const tag = makeTag('s157-default-true');
  const agentUser = await tempAgent(t, tag);
  const row = await db.agentProfile.findUnique({ where: { id: agentUser.agent.id } });
  assert.equal(row.notifKomisiStatement, true);
});
