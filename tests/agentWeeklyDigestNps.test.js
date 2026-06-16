// Stage 314 — agent weekly digest carries NPS roll + email body inlines
// the {{npsBlock}} placeholder when total > 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah } from './_helpers.js';
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
    await db.tripFeedback.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.payment.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

function pickInsideLastWeek(now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;
  const thisMon = new Date(today.getTime() - dow * 86_400_000);
  const start = new Date(thisMon.getTime() - 7 * 86_400_000);
  return new Date(start.getTime() + 1 * 86_400_000 + 14 * 3_600_000);
}

async function pastPaketWithReturn(t, tag) {
  const ret = new Date(Date.now() - 30 * 86_400_000);
  const dep = new Date(ret.getTime() - 10 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.tripFeedback.deleteMany({ where: { paketId: paket.id } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S314 — digest envelope carries npsRollup', async (t) => {
  const tag = makeTag('s314a');
  const agen = await tempAgent(t, tag);
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await pastPaketWithReturn(t, `${tag}-p`);

  const at = pickInsideLastWeek();
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  await db.tripFeedback.create({
    data: { bookingId: b.id, paketId: paket.id, score: 10, submittedAt: at },
  });

  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  assert.ok(digest, 'digest returned');
  assert.ok(digest.npsRollup, 'npsRollup attached');
  assert.equal(digest.npsRollup.total, 1);
  assert.equal(digest.npsRollup.promoters, 1);
  assert.equal(digest.npsRollup.npsPct, 100);
});

test('S314 — email body inlines NPS block when total > 0', async (t) => {
  const tag = makeTag('s314b');
  const agen = await tempAgent(t, tag);
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await pastPaketWithReturn(t, `${tag}-p`);

  const at = pickInsideLastWeek();
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  await db.tripFeedback.create({
    data: { bookingId: b.id, paketId: paket.id, score: 9, submittedAt: at },
  });

  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  await notifyAgentWeeklyDigest({ digest });
  const notif = await db.notification.findFirst({
    where: { type: 'AGENT_WEEKLY_DIGEST', relatedEntityId: agen.agent.id },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  assert.ok(notif);
  assert.match(notif.body, /NPS perjalanan minggu ini/);
  assert.match(notif.body, /%NPS/);
});

test('S314 — silent on clean weeks (no NPS block when total=0)', async (t) => {
  const tag = makeTag('s314c');
  const agen = await tempAgent(t, tag);
  const digest = await buildAgentWeeklyDigest({ agentId: agen.agent.id });
  assert.ok(digest);
  assert.equal(digest.npsRollup.total, 0);
  await notifyAgentWeeklyDigest({ digest });
  const notif = await db.notification.findFirst({
    where: { type: 'AGENT_WEEKLY_DIGEST', relatedEntityId: agen.agent.id },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  assert.ok(notif);
  assert.doesNotMatch(notif.body, /NPS perjalanan minggu ini/);
});
