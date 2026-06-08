// Stage 41 — komisi liability aging.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { getKomisiAging } from '../src/services/komisiAging.js';

const ONE_DAY_MS = 86_400_000;

async function tempAgent(t, tag) {
  const user = await tempUser(t, tag, { role: 'AGEN', status: 'ACTIVE' });
  const agent = await db.agentProfile.create({
    data: { userId: user.id, slug: `${tag}-slug`, displayName: `Agent ${tag}`, whatsapp: '+62811' },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: agent.id } });
    await db.agentProfile.deleteMany({ where: { id: agent.id } });
  });
  return { user, agent };
}

test('returns the expected envelope shape', async () => {
  const out = await getKomisiAging();
  assert.ok(Array.isArray(out.buckets));
  assert.equal(out.buckets.length, 4);
  for (const b of out.buckets) {
    assert.ok(out.totals[b.key]);
    assert.ok(typeof out.totals[b.key].count === 'number');
    assert.ok(typeof out.totals[b.key].amountIdr === 'number');
  }
  assert.ok(out.grandTotal && typeof out.grandTotal.agents === 'number');
});

test('komisi bucketed correctly by age', async (t) => {
  const tag = makeTag('ka-bucket');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Four EARNED komisi at carefully chosen ages
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '100000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 5 * ONE_DAY_MS),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '200000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 45 * ONE_DAY_MS),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '300000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 75 * ONE_DAY_MS),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '400000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 120 * ONE_DAY_MS),
    },
  });

  const out = await getKomisiAging();
  const row = out.rows.find((r) => r.agentId === agent.id);
  assert.ok(row);
  assert.equal(row.buckets['0-30'].amountIdr, 100_000);
  assert.equal(row.buckets['30-60'].amountIdr, 200_000);
  assert.equal(row.buckets['60-90'].amountIdr, 300_000);
  assert.equal(row.buckets['90+'].amountIdr, 400_000);
  assert.equal(row.totalAmountIdr, 1_000_000);
  assert.equal(row.oldestDays, 120);
});

test('PAID + CANCELLED + PENDING rows are excluded', async (t) => {
  const tag = makeTag('ka-status');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '500000',
      status: 'PAID', earnedAt: new Date(), paidAt: new Date(),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '500000',
      status: 'CANCELLED', earnedAt: new Date(),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: b.id, amount: '500000',
      status: 'PENDING',
    },
  });

  const out = await getKomisiAging();
  const row = out.rows.find((r) => r.agentId === agent.id);
  // No EARNED komisi → agent must NOT appear at all
  assert.equal(row, undefined);
});

test('sort: oldest komisi (largest oldestDays) lands at top', async (t) => {
  const tag = makeTag('ka-sort');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent: a1 } = await tempAgent(t, `${tag}-a`);
  const { agent: a2 } = await tempAgent(t, `${tag}-b`);

  const b1 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // a1 has the older komisi (100d), a2 has only fresh (5d)
  await db.komisi.create({
    data: {
      agentId: a1.id, bookingId: b1.id, amount: '100000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 100 * ONE_DAY_MS),
    },
  });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: a2.id, bookingId: b2.id, amount: '5000000',
      status: 'EARNED', earnedAt: new Date(Date.now() - 5 * ONE_DAY_MS),
    },
  });

  const out = await getKomisiAging();
  // Only our two agents; ignore other dev DB rows
  const ours = out.rows.filter((r) => r.agentId === a1.id || r.agentId === a2.id);
  // a1 with 100-day-old komisi must sort above a2 even though a2 has more Rp
  assert.equal(ours[0].agentId, a1.id);
  assert.equal(ours[1].agentId, a2.id);
});
