// Stage 170 — agent payout history CSV. One row per KomisiPayout
// with snapshot amount + method + reference + komisi count.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { buildAgentPayoutHistoryCsv } from '../src/services/komisiStatement.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisiPayout.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('buildAgentPayoutHistoryCsv: empty agent → header + footer only', async (t) => {
  const tag = makeTag('s170-empty');
  const u = await tempAgent(t, tag);
  const r = await buildAgentPayoutHistoryCsv({ agentId: u.agent.id });
  assert.equal(r.rowCount, 0);
  assert.equal(r.totalIdr, 0);
  assert.ok(r.csv.startsWith('\ufeff'));
  assert.match(r.csv, /paidAt,payoutNo,amountIdr/);
  assert.match(r.csv, /TOTAL/);
});

test('buildAgentPayoutHistoryCsv: covers payouts with snapshot fields', async (t) => {
  const tag = makeTag('s170-rows');
  const u = await tempAgent(t, tag);
  await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}-1`, agentId: u.agent.id,
      amount: '500000', method: 'TRANSFER',
      reference: 'TX-BCA-2026-0001', notes: 'Pencairan Mei',
      paidById: u.id, paidAt: new Date('2026-05-15'),
    },
  });
  await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}-2`, agentId: u.agent.id,
      amount: '300000', method: 'EWALLET',
      paidById: u.id, paidAt: new Date('2026-06-10'),
    },
  });

  const r = await buildAgentPayoutHistoryCsv({ agentId: u.agent.id });
  assert.equal(r.rowCount, 2);
  assert.equal(r.totalIdr, 800_000);
  assert.match(r.csv, new RegExp(`PO-${tag}-1`));
  assert.match(r.csv, new RegExp(`PO-${tag}-2`));
  assert.match(r.csv, /TRANSFER/);
  assert.match(r.csv, /EWALLET/);
  assert.match(r.csv, /TX-BCA-2026-0001/);
});

test('buildAgentPayoutHistoryCsv: sorted oldest-first', async (t) => {
  const tag = makeTag('s170-sort');
  const u = await tempAgent(t, tag);
  await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}-LATE`, agentId: u.agent.id,
      amount: '100', method: 'TRANSFER', paidById: u.id,
      paidAt: new Date('2026-06-01'),
    },
  });
  await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}-EARLY`, agentId: u.agent.id,
      amount: '200', method: 'TRANSFER', paidById: u.id,
      paidAt: new Date('2026-01-01'),
    },
  });
  const r = await buildAgentPayoutHistoryCsv({ agentId: u.agent.id });
  const idxEarly = r.csv.indexOf(`PO-${tag}-EARLY`);
  const idxLate = r.csv.indexOf(`PO-${tag}-LATE`);
  assert.ok(idxEarly < idxLate, 'early-paidAt row precedes late');
});

test('buildAgentPayoutHistoryCsv: komisi count reflects bundle size', async (t) => {
  const tag = makeTag('s170-bundle');
  const u = await tempAgent(t, tag);
  const payout = await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}`, agentId: u.agent.id,
      amount: '500000', method: 'TRANSFER', paidById: u.id,
    },
  });
  // 3 komisi rows bundled into this payout (need a booking for each)
  const { tempPaket, tempJemaah, tempBooking } = await import('./_helpers.js');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  for (let i = 0; i < 3; i++) {
    const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await db.komisi.create({
      data: {
        agentId: u.agent.id, bookingId: booking.id, payoutId: payout.id,
        amount: '100000', currency: 'IDR', status: 'PAID',
        earnedAt: new Date(), paidAt: new Date(),
      },
    });
  }
  const r = await buildAgentPayoutHistoryCsv({ agentId: u.agent.id });
  // CSV row should report 3 komisi lines
  assert.match(r.csv, /,3,/);
});
