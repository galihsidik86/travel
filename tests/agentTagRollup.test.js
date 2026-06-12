// Stage 242 — agen-facing booking tag rollup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { getAgentTagRollup } from '../src/services/agentTagRollup.js';
import { hashPassword } from '../src/lib/auth.js';

async function makeAgent(t, tag) {
  const email = `${tag}-agen@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811',
    },
  });
  const profile = await db.agentProfile.create({
    data: { userId: user.id, slug: tag, displayName: `Agen ${tag}`, whatsapp: '+62811' },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { agentId: profile.id } });
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, profile };
}

async function makeBookingWithTags(paket, jemaahId, agentId, tags = null, paxCount = 1) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId, agentId,
      kelas: 'QUAD', paxCount, totalAmount: '500', paidAmount: '0', status: 'PENDING',
      tags,
    },
  });
}

test('getAgentTagRollup: empty when agentId missing', async () => {
  const r = await getAgentTagRollup({});
  assert.deepEqual(r, { tags: [], totalTaggedBookings: 0 });
});

test('getAgentTagRollup: empty when no tagged bookings', async (t) => {
  const tag = makeTag('s242-empty');
  const { profile } = await makeAgent(t, tag);
  const r = await getAgentTagRollup({ agentId: profile.id });
  assert.equal(r.tags.length, 0);
  assert.equal(r.totalTaggedBookings, 0);
});

test('getAgentTagRollup: counts pax per tag', async (t) => {
  const tag = makeTag('s242-count');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBookingWithTags(paket, u.jemaah.id, profile.id, ['VIP'], 1);
  await makeBookingWithTags(paket, u.jemaah.id, profile.id, ['VIP'], 2);
  await makeBookingWithTags(paket, u.jemaah.id, profile.id, ['LANSIA'], 1);

  const r = await getAgentTagRollup({ agentId: profile.id });
  const vip = r.tags.find((t) => t.tag === 'VIP');
  const lansia = r.tags.find((t) => t.tag === 'LANSIA');
  assert.equal(vip.bookings, 2);
  assert.equal(vip.paxCount, 3);
  assert.equal(lansia.bookings, 1);
});

test('getAgentTagRollup: scoped to agen — no cross-agen leak', async (t) => {
  const tag = makeTag('s242-isolate');
  const a1 = await makeAgent(t, tag + '-1');
  const a2 = await makeAgent(t, tag + '-2');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBookingWithTags(paket, u.jemaah.id, a1.profile.id, ['VIP']);
  await makeBookingWithTags(paket, u.jemaah.id, a2.profile.id, ['VIP']);

  const r1 = await getAgentTagRollup({ agentId: a1.profile.id });
  const vip = r1.tags.find((t) => t.tag === 'VIP');
  // a1 should only see their own 1 VIP
  assert.equal(vip.bookings, 1);
});

test('getAgentTagRollup: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s242-cancel');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-c`, paketId: paket.id, jemaahId: u.jemaah.id, agentId: profile.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED', tags: ['VIP'],
    },
  });

  const r = await getAgentTagRollup({ agentId: profile.id });
  const vip = r.tags.find((t) => t.tag === 'VIP');
  assert.equal(vip, undefined);
});

test('getAgentTagRollup: multi-tag bookings counted under each tag', async (t) => {
  const tag = makeTag('s242-multi');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBookingWithTags(paket, u.jemaah.id, profile.id, ['VIP', 'HONEYMOON']);

  const r = await getAgentTagRollup({ agentId: profile.id });
  const vip = r.tags.find((t) => t.tag === 'VIP');
  const honey = r.tags.find((t) => t.tag === 'HONEYMOON');
  assert.equal(vip.bookings, 1);
  assert.equal(honey.bookings, 1);
});

test('getAgentTagRollup: sorts by paxCount desc', async (t) => {
  const tag = makeTag('s242-sort');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Tag A: 3 bookings × 1 pax = 3. Tag B: 1 × 1 = 1
  const tagA = `XA-${tag.toUpperCase()}`;
  const tagB = `XB-${tag.toUpperCase()}`;
  for (let i = 0; i < 3; i += 1) {
    await makeBookingWithTags(paket, u.jemaah.id, profile.id, [tagA]);
  }
  await makeBookingWithTags(paket, u.jemaah.id, profile.id, [tagB]);

  const r = await getAgentTagRollup({ agentId: profile.id });
  const idxA = r.tags.findIndex((t) => t.tag === tagA);
  const idxB = r.tags.findIndex((t) => t.tag === tagB);
  assert.ok(idxA >= 0 && idxB >= 0);
  assert.ok(idxA < idxB);
});
