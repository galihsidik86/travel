// Stage 14 — AgentPaketKomisi precedence chain + idempotency.
//
// The full precedence (most → least specific):
//   1. AgentPaketKomisi(agentId, paketId).rate
//   2. AgentProfile.komisiRateOverride
//   3. Paket.komisiRate
//   4. DEFAULT_KOMISI_RATE (0.06)
//
// The rate is locked into Komisi.amount at LUNAS transition. Tests here
// drive recordPayment to a LUNAS state and assert the resulting komisi
// amount matches the expected rate × totalAmount.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';

const ctx = { req: fakeReq, actor: systemActor };

async function tempAgent(t, tag, { komisiRateOverride = null } = {}) {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`, whatsapp: '+62811',
        komisiRateOverride,
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.agentPaketKomisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function tempBooking(t, { paket, jemaah, agentId, totalAmount = '10000000' }) {
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id, agentId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount, paidAmount: '0', status: 'PENDING',
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: booking.id } });
    await db.komisi.deleteMany({ where: { bookingId: booking.id } });
    await db.booking.deleteMany({ where: { id: booking.id } });
  });
  return booking;
}

async function drivetoLunas(booking) {
  await recordPayment({
    ...ctx, bookingId: booking.id, amount: 10_000_000,
    method: 'TRANSFER', currency: 'IDR',
  });
}

async function setPaketRate(paketId, rate) {
  await db.paket.update({ where: { id: paketId }, data: { komisiRate: rate } });
}

describe('AgentPaketKomisi precedence', () => {
  test('matrix wins over per-agent override + paket rate', async (t) => {
    const tag = makeTag('mtx-win');
    // paket rate 6%, per-agent override 10%, matrix 15% → expect 15%
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setPaketRate(paket.id, 0.06);
    const agent = await tempAgent(t, tag, { komisiRateOverride: 0.10 });
    await db.agentPaketKomisi.create({
      data: { agentId: agent.agent.id, paketId: paket.id, rate: 0.15 },
    });
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await drivetoLunas(bk);

    const k = await db.komisi.findFirst({ where: { bookingId: bk.id } });
    assert.ok(k, 'komisi created');
    assert.equal(Number(k.amount.toString()), 1_500_000, '15% × 10M = 1.5M');
  });

  test('no matrix → falls through to per-agent override', async (t) => {
    const tag = makeTag('mtx-fall1');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setPaketRate(paket.id, 0.06);
    const agent = await tempAgent(t, tag, { komisiRateOverride: 0.10 });
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await drivetoLunas(bk);

    const k = await db.komisi.findFirst({ where: { bookingId: bk.id } });
    assert.equal(Number(k.amount.toString()), 1_000_000, '10% × 10M = 1M');
  });

  test('no matrix + no override → falls through to paket rate', async (t) => {
    const tag = makeTag('mtx-fall2');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setPaketRate(paket.id, 0.08);
    const agent = await tempAgent(t, tag); // no override
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await drivetoLunas(bk);

    const k = await db.komisi.findFirst({ where: { bookingId: bk.id } });
    assert.equal(Number(k.amount.toString()), 800_000, '8% × 10M = 800k');
  });

  test('matrix is scoped per (agent, paket) — different paket falls back', async (t) => {
    const tag = makeTag('mtx-scope');
    const paketA = await tempPaket(t, `pktA-${tag}`);
    const paketB = await tempPaket(t, `pktB-${tag}`);
    await setPaketRate(paketA.id, 0.06);
    await setPaketRate(paketB.id, 0.06);
    const agent = await tempAgent(t, tag);
    // Matrix override only for paketA — paketB must use the default chain
    await db.agentPaketKomisi.create({
      data: { agentId: agent.agent.id, paketId: paketA.id, rate: 0.20 },
    });
    const jem = await tempJemaah(t, tag);

    const bkA = await tempBooking(t, { paket: paketA, jemaah: jem.jemaah, agentId: agent.agent.id });
    const bkB = await tempBooking(t, { paket: paketB, jemaah: jem.jemaah, agentId: agent.agent.id });
    await drivetoLunas(bkA);
    await drivetoLunas(bkB);

    const kA = await db.komisi.findFirst({ where: { bookingId: bkA.id } });
    const kB = await db.komisi.findFirst({ where: { bookingId: bkB.id } });
    assert.equal(Number(kA.amount.toString()), 2_000_000, '20% × 10M on paketA');
    assert.equal(Number(kB.amount.toString()), 600_000,  '6% × 10M on paketB (matrix doesn\u2019t leak)');
  });
});

describe('AgentPaketKomisi idempotency + invariants', () => {
  test('upsert with same (agent, paket) replaces the rate; no duplicate rows', async (t) => {
    const tag = makeTag('mtx-upsert');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const agent = await tempAgent(t, tag);
    const key = { agentId_paketId: { agentId: agent.agent.id, paketId: paket.id } };

    await db.agentPaketKomisi.upsert({
      where: key,
      create: { agentId: agent.agent.id, paketId: paket.id, rate: 0.10 },
      update: { rate: 0.10 },
    });
    await db.agentPaketKomisi.upsert({
      where: key,
      create: { agentId: agent.agent.id, paketId: paket.id, rate: 0.18 },
      update: { rate: 0.18 },
    });
    const rows = await db.agentPaketKomisi.findMany({
      where: { agentId: agent.agent.id, paketId: paket.id },
    });
    assert.equal(rows.length, 1, 'single row after two upserts');
    assert.equal(Number(rows[0].rate.toString()), 0.18, 'second value wins');
  });

  test('historical Komisi NOT recomputed when matrix rate changes later', async (t) => {
    // Mirrors the 5u/5v invariant — the rate at LUNAS is locked in.
    const tag = makeTag('mtx-immutable');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setPaketRate(paket.id, 0.06);
    const agent = await tempAgent(t, tag);
    await db.agentPaketKomisi.create({
      data: { agentId: agent.agent.id, paketId: paket.id, rate: 0.20 },
    });
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await drivetoLunas(bk);

    const before = await db.komisi.findFirst({ where: { bookingId: bk.id } });
    assert.equal(Number(before.amount.toString()), 2_000_000);

    // Now bump the matrix rate to 0.05. Historical row should NOT move.
    await db.agentPaketKomisi.update({
      where: { agentId_paketId: { agentId: agent.agent.id, paketId: paket.id } },
      data: { rate: 0.05 },
    });
    const after = await db.komisi.findFirst({ where: { bookingId: bk.id } });
    assert.equal(Number(after.amount.toString()), 2_000_000, 'historical komisi untouched');
  });

  test('cascade delete: removing the paket drops its AgentPaketKomisi rows', async (t) => {
    const tag = makeTag('mtx-cascade');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const agent = await tempAgent(t, tag);
    await db.agentPaketKomisi.create({
      data: { agentId: agent.agent.id, paketId: paket.id, rate: 0.12 },
    });
    // tempPaket's t.after deletes the paket — verify cascade after that runs
    // implicitly. To avoid teardown-order coupling, do an explicit delete now.
    await db.paket.delete({ where: { id: paket.id } });
    const left = await db.agentPaketKomisi.findMany({ where: { agentId: agent.agent.id } });
    assert.equal(left.length, 0, 'matrix row dropped on paket delete');
  });
});
