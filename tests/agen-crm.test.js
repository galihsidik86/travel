// Agent CRM dashboard aggregator tests.
//   - getAgentDashboard scopes everything to the agent (no leakage)
//   - kpis line up with pipeline counts
//   - LUNAS payment delta moves lunasCount + lunasRevenue
//   - null when agentId doesn't resolve
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAgentDashboard } from '../src/services/agenCrm.js';
import { recordPayment } from '../src/services/payment.js';

const ctx = { req: fakeReq, actor: systemActor };

async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`, whatsapp: '+62811',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { agentId: u.agent.id } });
    await db.komisiPayout.deleteMany({ where: { agentId: u.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

describe('getAgentDashboard — null/shape', () => {
  test('returns null for unknown agentId', async () => {
    assert.equal(await getAgentDashboard('does-not-exist'), null);
  });

  test('shape: agent + kpis + pipeline + komisi + payouts + marketingPaket + analytics', async (t) => {
    const tag = makeTag('agen-shape');
    const agent = await tempAgent(t, tag);

    const r = await getAgentDashboard(agent.agent.id);
    assert.ok(r);
    assert.equal(r.agent.id, agent.agent.id);
    assert.equal(r.agent.slug, agent.agent.slug);

    // KPIs are numbers (conversionPct can be null when no bookings)
    for (const k of [
      'bookingsThisMonth', 'totalBookings', 'leadCount', 'leadPotential',
      'hotCount', 'hotPotential', 'lunasCount', 'lunasRevenue',
      'komisiEarned', 'komisiWallet', 'komisiPending',
    ]) {
      assert.equal(typeof r.kpis[k], 'number', `kpis.${k}`);
    }
    assert.ok(r.kpis.conversionPct === null || typeof r.kpis.conversionPct === 'number');

    // Pipeline shape
    for (const col of ['cold', 'warm', 'hot', 'lunas']) {
      assert.ok(Array.isArray(r.pipeline[col]), `pipeline.${col} is array`);
    }
    // Fresh agent: nothing in any column
    assert.equal(r.pipeline.cold.length + r.pipeline.warm.length + r.pipeline.hot.length + r.pipeline.lunas.length, 0);

    // Komisi roll-up
    for (const k of ['pending', 'earned', 'paid', 'wallet', 'total']) {
      assert.equal(typeof r.komisi[k], 'number', `komisi.${k}`);
    }

    // Payouts capped at 20
    assert.ok(Array.isArray(r.payouts));
    assert.ok(r.payouts.length <= 20);

    // Marketing kit = ACTIVE paket
    assert.ok(Array.isArray(r.marketingPaket));

    // Analytics
    assert.ok(r.analytics.funnel);
    assert.ok(Array.isArray(r.analytics.sourceBreakdown));
    assert.ok(Array.isArray(r.analytics.daily));
  });
});

describe('getAgentDashboard — scoping', () => {
  test("agent A's dashboard does not include agent B's bookings or komisi", async (t) => {
    const tag = makeTag('agen-scope');
    const user = await tempJemaah(t, tag);
    const agentA = await tempAgent(t, `${tag}-a`);
    const agentB = await tempAgent(t, `${tag}-b`);
    const paket = await tempPaket(t, tag);

    // Booking for A and a separate booking for B
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agentA.agent.id, agentSlugCap: agentA.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agentB.agent.id, agentSlugCap: agentB.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '2000000', paidAmount: '0', status: 'PENDING',
      },
    });
    // Komisi rows seeded for both
    await db.komisi.create({
      data: { bookingId: (await db.booking.findFirst({ where: { agentId: agentA.agent.id } })).id,
              agentId: agentA.agent.id, amount: '60000', currency: 'IDR', status: 'EARNED', earnedAt: new Date() },
    });
    await db.komisi.create({
      data: { bookingId: (await db.booking.findFirst({ where: { agentId: agentB.agent.id } })).id,
              agentId: agentB.agent.id, amount: '120000', currency: 'IDR', status: 'EARNED', earnedAt: new Date() },
    });

    const rA = await getAgentDashboard(agentA.agent.id);
    const rB = await getAgentDashboard(agentB.agent.id);

    assert.equal(rA.kpis.totalBookings, 1);
    assert.equal(rA.kpis.hotCount, 1, "A has 1 hot booking (its own)");
    assert.equal(rA.kpis.hotPotential, 1_000_000);
    assert.equal(rA.komisi.earned, 60_000);

    assert.equal(rB.kpis.totalBookings, 1);
    assert.equal(rB.kpis.hotPotential, 2_000_000);
    assert.equal(rB.komisi.earned, 120_000);

    // Cross-leak check
    assert.equal(rA.komisi.earned, 60_000, "A doesn't see B's komisi");
    for (const b of rA.pipeline.hot) {
      assert.equal(b.agentId, agentA.agent.id, 'every hot booking belongs to A');
    }
  });

  test('LUNAS payment delta: lunasCount + lunasRevenue grow by exactly 1 + totalAmount', async (t) => {
    const tag = makeTag('agen-lunas-delta');
    const user = await tempJemaah(t, tag);
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, tag);

    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '750000', paidAmount: '0', status: 'PENDING',
      },
    });
    const before = await getAgentDashboard(agent.agent.id);
    assert.equal(before.kpis.lunasCount, 0);

    await recordPayment({ ...ctx, bookingId: booking.id, amount: 750_000, method: 'TRANSFER' });
    const after = await getAgentDashboard(agent.agent.id);
    assert.equal(after.kpis.lunasCount, 1, '1 booking flipped to LUNAS');
    assert.equal(after.kpis.lunasRevenue, 750_000);
    // conversionPct = 1 LUNAS / 1 total = 100
    assert.equal(after.kpis.conversionPct, 100);
  });

  test('pipeline.lunas + .hot + lead lists match KPI counts', async (t) => {
    const tag = makeTag('agen-coherence');
    const user = await tempJemaah(t, tag);
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, tag);

    // 1 hot, 1 lunas, 2 leads (1 cold + 1 warm)
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-H`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-L`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '500000', paidAmount: '500000', status: 'LUNAS',
      },
    });
    await db.lead.create({
      data: {
        agentId: agent.agent.id, fullName: 'Cold Lead', phone: '+62800',
        source: 'WA', status: 'COLD', estValueIdr: '300000',
      },
    });
    await db.lead.create({
      data: {
        agentId: agent.agent.id, fullName: 'Warm Lead', phone: '+62801',
        source: 'IG', status: 'WARM', estValueIdr: '400000',
      },
    });

    const r = await getAgentDashboard(agent.agent.id);
    assert.equal(r.kpis.hotCount, r.pipeline.hot.length);
    assert.equal(r.kpis.lunasCount, r.pipeline.lunas.length);
    assert.equal(r.kpis.leadCount, r.pipeline.cold.length + r.pipeline.warm.length);
    assert.equal(r.kpis.leadPotential, 700_000, '300k + 400k from lead estValueIdr');
    assert.equal(r.kpis.totalBookings, 2);
    assert.equal(r.kpis.conversionPct, 50, '1 LUNAS / 2 total');
  });
});
