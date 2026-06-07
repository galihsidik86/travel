// Stage 37 — smart payout reminder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { getOverduePayoutCandidates } from '../src/services/payoutReminder.js';
import { notifyPayoutReminder } from '../src/services/notifications.js';

async function tempAgent(t, tag, { status = 'ACTIVE' } = {}) {
  const user = await tempUser(t, tag, { role: 'AGEN', status });
  const agent = await db.agentProfile.create({
    data: { userId: user.id, slug: `${tag}-slug`, displayName: `Agent ${tag}`, whatsapp: '+62811' },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: agent.id } });
    await db.agentProfile.deleteMany({ where: { id: agent.id } });
  });
  return { user, agent };
}

test('agents below threshold are excluded', async (t) => {
  const tag = makeTag('pr-below');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  // Earn 500.000 — below 1M default threshold
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '500000', status: 'EARNED', earnedAt: new Date(),
    },
  });
  const result = await getOverduePayoutCandidates();
  assert.ok(!result.rows.some((r) => r.agentId === agent.id), 'below-threshold agent must be excluded');
});

test('agents above threshold are included with ageDays + totalFormatted', async (t) => {
  const tag = makeTag('pr-above');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  const oldDate = new Date(Date.now() - 14 * 86_400_000); // 14 days ago
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Two EARNED komisi summing 2.500.000 (well above 1M)
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '1500000', status: 'EARNED', earnedAt: oldDate,
    },
  });
  const newer = new Date(Date.now() - 2 * 86_400_000);
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '1000000', status: 'EARNED', earnedAt: newer,
    },
  });

  const result = await getOverduePayoutCandidates();
  const row = result.rows.find((r) => r.agentId === agent.id);
  assert.ok(row);
  assert.equal(row.totalIdr, 2_500_000);
  assert.equal(row.count, 2);
  // oldestEarnedAt should be the 14-day one
  assert.ok(row.ageDays >= 13 && row.ageDays <= 15, `ageDays was ${row.ageDays}`);
  assert.equal(row.totalFormatted, 'Rp 2.500.000');
});

test('PAID rows do not bump the total (status filter)', async (t) => {
  const tag = makeTag('pr-paid');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // 1.5M EARNED + 1M PAID — only EARNED counts
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '1500000', status: 'EARNED', earnedAt: new Date(),
    },
  });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '1000000', status: 'PAID', earnedAt: new Date(), paidAt: new Date(),
    },
  });
  const result = await getOverduePayoutCandidates();
  const row = result.rows.find((r) => r.agentId === agent.id);
  assert.ok(row);
  assert.equal(row.totalIdr, 1_500_000, 'PAID row must not be counted');
});

test('threshold param is respected (Rp 500k threshold catches the small fish)', async (t) => {
  const tag = makeTag('pr-thresh');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const { agent } = await tempAgent(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: {
      agentId: agent.id, bookingId: booking.id,
      amount: '700000', status: 'EARNED', earnedAt: new Date(),
    },
  });
  // Default 1M → not included
  const withDefault = await getOverduePayoutCandidates();
  assert.ok(!withDefault.rows.some((r) => r.agentId === agent.id));
  // 500k threshold → included
  const withLower = await getOverduePayoutCandidates({ thresholdIdr: 500_000 });
  assert.ok(withLower.rows.some((r) => r.agentId === agent.id));
});

test('notifyPayoutReminder is a no-op when no candidates', async () => {
  // Test against the empty shape directly — far simpler than mocking out
  // the dev DB to have zero EARNED komisi
  const empty = { rows: [], counts: { candidates: 0, thresholdIdr: 1_000_000, grandTotalIdr: 0 } };
  const r = await notifyPayoutReminder({ candidates: empty });
  assert.equal(r.enqueued, 0);
  assert.equal(r.skipped, true);
});

test('notifyPayoutReminder fans out to all 3 admin roles when candidates present', async (t) => {
  const tag = makeTag('pr-fan');
  const owner = await tempUser(t, `${tag}-o`, { role: 'OWNER', status: 'ACTIVE' });
  const sa = await tempUser(t, `${tag}-s`, { role: 'SUPERADMIN', status: 'ACTIVE' });
  const mo = await tempUser(t, `${tag}-m`, { role: 'MANAJER_OPS', status: 'ACTIVE' });
  const kasir = await tempUser(t, `${tag}-k`, { role: 'KASIR', status: 'ACTIVE' });

  const fake = {
    rows: [{
      agentId: 'fake-id', agent: { slug: 'demo', displayName: 'Demo Agen' },
      totalIdr: 5_000_000, count: 3, ageDays: 12, totalFormatted: 'Rp 5.000.000',
    }],
    counts: { candidates: 1, thresholdIdr: 1_000_000, grandTotalIdr: 5_000_000 },
  };
  const r = await notifyPayoutReminder({ candidates: fake });
  assert.ok(r.enqueued >= 3, 'must fan out to ≥3 admins');

  const got = await db.notification.findMany({
    where: {
      type: 'PAYOUT_REMINDER_OWNER',
      recipientEmail: { in: [owner.email, sa.email, mo.email, kasir.email] },
    },
    select: { recipientEmail: true, body: true },
  });
  const emails = new Set(got.map((g) => g.recipientEmail));
  assert.ok(emails.has(owner.email));
  assert.ok(emails.has(sa.email));
  assert.ok(emails.has(mo.email));
  assert.ok(!emails.has(kasir.email), 'KASIR must NOT receive (not in admin fan-out)');
  assert.match(got[0].body, /Demo Agen/);

  await db.notification.deleteMany({
    where: { type: 'PAYOUT_REMINDER_OWNER', recipientEmail: { in: [owner.email, sa.email, mo.email] } },
  });
});
