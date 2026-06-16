// Stage 301 + 302 — agent notif on cancel + refund.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';
import { issueRefund } from '../src/services/refund.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-agent@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811000000',
      agent: { create: { slug: tag, displayName: `Agen ${tag}`, whatsapp: '+6281100000001' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientEmail: user.email } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.updateMany({ where: { agentId: user.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

// ── S301 cancel-to-agent ──────────────────────────────────────

test('cancelBooking: enqueues BOOKING_CANCELLED_AGENT to the agent', async (t) => {
  const tag = `acra-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const ag = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { agentId: ag.agent.id } });

  const before = await db.notification.count({
    where: { type: 'BOOKING_CANCELLED_AGENT', recipientEmail: ag.email },
  });
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'admin cancel smoke',
  });
  const after = await db.notification.count({
    where: { type: 'BOOKING_CANCELLED_AGENT', recipientEmail: ag.email },
  });
  assert.ok(after > before, 'EMAIL notif enqueued to agent');
  // Also expect a WA notif since whatsapp is set
  const wa = await db.notification.count({
    where: { type: 'BOOKING_CANCELLED_AGENT', recipientPhone: ag.agent.whatsapp },
  });
  assert.ok(wa > 0, 'WA notif enqueued to agent');
});

test('cancelBooking: walk-in booking (no agent) skips the notif', async (t) => {
  const tag = `acra-wi-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // agentId stays null
  const before = await db.notification.count({
    where: { type: 'BOOKING_CANCELLED_AGENT', relatedEntityId: b.id },
  });
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'walk-in cancel',
  });
  const after = await db.notification.count({
    where: { type: 'BOOKING_CANCELLED_AGENT', relatedEntityId: b.id },
  });
  assert.equal(after, before, 'no agent → no notif');
});

test('cancelBooking: notif body carries cancel reason + jemaah name', async (t) => {
  const tag = `acra-body-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jemaah.jemaah.id }, data: { fullName: 'Body Test Jemaah' },
  });
  const ag = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { agentId: ag.agent.id } });
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'visa-rejected-distinctive-token',
  });
  const notif = await db.notification.findFirst({
    where: { type: 'BOOKING_CANCELLED_AGENT', recipientEmail: ag.email },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  assert.ok(notif.body.includes('visa-rejected-distinctive-token'));
  assert.ok(notif.body.includes('Body Test Jemaah'));
});

// ── S302 refund-to-agent ─────────────────────────────────────

test('issueRefund: enqueues REFUND_ISSUED_AGENT to the agent', async (t) => {
  const tag = `acrar-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const ag = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({
    where: { id: b.id },
    data: { agentId: ag.agent.id, paidAmount: '5000000' },
  });
  // Must cancel before refund (refund only works on CANCELLED bookings)
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'pre-refund cancel',
  });
  const before = await db.notification.count({
    where: { type: 'REFUND_ISSUED_AGENT', recipientEmail: ag.email },
  });
  await issueRefund({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, amount: 2000000, method: 'TRANSFER', reason: 'partial refund smoke',
  });
  const after = await db.notification.count({
    where: { type: 'REFUND_ISSUED_AGENT', recipientEmail: ag.email },
  });
  assert.ok(after > before, 'agent refund notif enqueued');
});

test('issueRefund: partial vs full refund flag in body', async (t) => {
  const tag = `acrar-pf-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const ag = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({
    where: { id: b.id },
    data: { agentId: ag.agent.id, paidAmount: '5000000' },
  });
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'cancel before full refund',
  });
  await issueRefund({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, amount: 5000000, method: 'TRANSFER', reason: 'full refund',
  });
  const notif = await db.notification.findFirst({
    where: { type: 'REFUND_ISSUED_AGENT', recipientEmail: ag.email },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(notif);
  // Full refund → "penuh"
  assert.ok(notif.body.includes('penuh'));
  // Payload carries the partial flag
  assert.equal(notif.payload.partial, false);
  assert.equal(notif.payload.amountIdr, 5000000);
});

test('issueRefund: walk-in booking (no agent) skips the notif', async (t) => {
  const tag = `acrar-wi-${Math.random().toString(36).slice(2, 6)}`;
  const paket = await tempPaket(t, tag);
  const jemaah = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id, totalAmount: '5000000' });
  await db.booking.update({ where: { id: b.id }, data: { paidAmount: '5000000' } });
  await cancelBooking({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, reason: 'cancel',
  });
  const before = await db.notification.count({
    where: { type: 'REFUND_ISSUED_AGENT', relatedEntityId: b.id },
  });
  await issueRefund({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id, amount: 1000000, method: 'TRANSFER', reason: 'partial',
  });
  const after = await db.notification.count({
    where: { type: 'REFUND_ISSUED_AGENT', relatedEntityId: b.id },
  });
  assert.equal(after, before, 'no agent → no notif');
});
