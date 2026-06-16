// Stage 306 — agent weekly digest now carries reason rollup + the
// email body renders an inline "ALASAN CANCEL / REFUND" block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { buildAgentWeeklyDigest } from '../src/services/agentWeeklyDigest.js';
import { notifyAgentWeeklyDigest } from '../src/services/notifications.js';

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-ag@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { slug: `${tag}-slug`, displayName: `Agen ${tag}`, whatsapp: '+62811', tier: 'BRONZE' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: user.agent.id } });
    await db.payment.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

// resolveLastFullWeek: previous full Mon-Sun. Build dates inside that window.
function pickInsideLastWeek(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const thisMon = new Date(today.getTime() - dow * 86_400_000);
  const start = new Date(thisMon.getTime() - 7 * 86_400_000);
  // 2pm Tuesday of the previous full week — safely inside.
  return new Date(start.getTime() + 1 * 86_400_000 + 14 * 3_600_000);
}

test('S306 — digest envelope carries reasonRollup', async (t) => {
  const tag = makeTag('s306a');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  const at = pickInsideLastWeek();
  await db.booking.create({
    data: {
      bookingNo: `RP-S306-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'CANCELLED', cancelledAt: at, cancelReasonCode: 'PAYMENT_NOT_RECEIVED',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-S306-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'CANCELLED', cancelledAt: at, cancelReasonCode: 'PAYMENT_NOT_RECEIVED',
    },
  });

  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  assert.ok(digest, 'digest returned');
  assert.ok(digest.reasonRollup, 'reasonRollup attached');
  assert.equal(digest.reasonRollup.cancelByCode.length, 1);
  assert.equal(digest.reasonRollup.cancelByCode[0].code, 'PAYMENT_NOT_RECEIVED');
  assert.equal(digest.reasonRollup.cancelByCode[0].count, 2);
});

test('S306 — email body inlines the ALASAN block when reasonRollup populated', async (t) => {
  const tag = makeTag('s306b');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  const at = pickInsideLastWeek();
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-S306-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'CANCELLED', cancelledAt: at, cancelReasonCode: 'DOCUMENT_INCOMPLETE',
    },
  });
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '-300000', currency: 'IDR',
      method: 'TRANSFER', status: 'REFUNDED', refundReasonCode: 'VISA_REJECTED',
      createdAt: at,
    },
  });

  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  const { enqueued } = await notifyAgentWeeklyDigest({ digest });
  assert.equal(enqueued, 1);
  const notif = await db.notification.findFirst({
    where: { type: 'AGENT_WEEKLY_DIGEST', relatedEntityId: agen.agent.id },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  assert.ok(notif, 'notif enqueued');
  assert.match(notif.body, /ALASAN CANCEL \/ REFUND/);
  assert.match(notif.body, /Dokumen tidak lengkap/);
  assert.match(notif.body, /Visa ditolak/);
});

test('S306 — silent on clean weeks (no reasonBlock in body)', async (t) => {
  const tag = makeTag('s306c');
  const agen = await tempAgent(t, `${tag}-a`);
  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  assert.ok(digest);
  assert.deepEqual(digest.reasonRollup.cancelByCode, []);
  assert.deepEqual(digest.reasonRollup.refundByCode, []);
  await notifyAgentWeeklyDigest({ digest });
  const notif = await db.notification.findFirst({
    where: { type: 'AGENT_WEEKLY_DIGEST', relatedEntityId: agen.agent.id },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  assert.ok(notif, 'notif enqueued');
  assert.doesNotMatch(notif.body, /ALASAN CANCEL \/ REFUND/);
});
