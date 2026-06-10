// Stage 168 — lifetime komisi CSV download for /agen Wallet tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { buildAgentLifetimeKomisiCsv } from '../src/services/komisiStatement.js';
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

test('buildAgentLifetimeKomisiCsv: empty agent → header + footer only', async (t) => {
  const tag = makeTag('s168-empty');
  const u = await tempAgent(t, tag);
  const r = await buildAgentLifetimeKomisiCsv({ agentId: u.agent.id });
  assert.equal(r.rowCount, 0);
  assert.equal(r.totals.earnedIdr, 0);
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM');
  assert.match(r.csv, /createdAt,earnedAt,paidAt/);
  assert.match(r.csv, /TOTAL/);
});

test('buildAgentLifetimeKomisiCsv: covers all status types', async (t) => {
  const tag = makeTag('s168-all');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // 3 komisi rows with different statuses
  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-01-15'),
    },
  });
  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id,
      amount: '200000', currency: 'IDR', status: 'PAID',
      earnedAt: new Date('2026-02-15'), paidAt: new Date('2026-03-01'),
    },
  });
  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id,
      amount: '50000', currency: 'IDR', status: 'CANCELLED',
      earnedAt: new Date('2026-03-15'),
    },
  });

  const r = await buildAgentLifetimeKomisiCsv({ agentId: u.agent.id });
  assert.equal(r.rowCount, 3);
  assert.equal(r.totals.earnedIdr, 100_000);
  assert.equal(r.totals.paidIdr, 200_000);
  // All three statuses present
  assert.match(r.csv, /EARNED/);
  assert.match(r.csv, /PAID/);
  assert.match(r.csv, /CANCELLED/);
});

test('buildAgentLifetimeKomisiCsv: sorted oldest-first', async (t) => {
  const tag = makeTag('s168-sort');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id,
      amount: '100', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-03-15'),
    },
  });
  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id,
      amount: '200', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-01-15'),
    },
  });

  const r = await buildAgentLifetimeKomisiCsv({ agentId: u.agent.id });
  // Find positions of the two earnedAt strings in the CSV
  const idxJan = r.csv.indexOf('2026-01-15');
  const idxMar = r.csv.indexOf('2026-03-15');
  assert.ok(idxJan > 0 && idxMar > 0, 'both dates appear');
  assert.ok(idxJan < idxMar, 'January row comes before March row');
});

test('buildAgentLifetimeKomisiCsv: payout reference appears when present', async (t) => {
  const tag = makeTag('s168-payout');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  // Create a payout + komisi linked to it
  const payout = await db.komisiPayout.create({
    data: {
      payoutNo: `PO-${tag}-1`, agentId: u.agent.id,
      amount: '500000', method: 'TRANSFER',
      paidById: u.id,
    },
  });
  await db.komisi.create({
    data: {
      agentId: u.agent.id, bookingId: booking.id, payoutId: payout.id,
      amount: '500000', currency: 'IDR', status: 'PAID',
      earnedAt: new Date('2026-02-01'), paidAt: new Date('2026-03-01'),
    },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { payoutId: payout.id } });
    await db.komisiPayout.deleteMany({ where: { id: payout.id } });
  });

  const r = await buildAgentLifetimeKomisiCsv({ agentId: u.agent.id });
  assert.match(r.csv, new RegExp(`PO-${tag}-1`));
});
