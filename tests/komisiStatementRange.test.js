// Stage 161 — transient cross-paket statement over a custom date range.
// Aggregates komisi across paket for the window; capped 90 days.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { renderRangeStatementBuffer } from '../src/services/komisiStatement.js';
import { hashPassword } from '../src/lib/auth.js';
import { HttpError } from '../src/middleware/error.js';

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
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('renderRangeStatementBuffer: aggregates across multiple paket in window', async (t) => {
  const tag = makeTag('s161-cross');
  const agentUser = await tempAgent(t, tag);
  const paketA = await tempPaket(t, `${tag}-A`);
  const paketB = await tempPaket(t, `${tag}-B`);
  const jem = await tempJemaah(t, tag);
  const bookingA = await tempBooking({ paket: paketA, jemaahProfileId: jem.jemaah.id });
  const bookingB = await tempBooking({ paket: paketB, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: bookingA.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-01-15') },
  });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: bookingB.id,
      amount: '200000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-02-20') },
  });

  const r = await renderRangeStatementBuffer({
    agentId: agentUser.agent.id, from: '2026-01-01', to: '2026-03-31',
  });
  assert.equal(r.buffer.slice(0, 4).toString(), '%PDF');
  // Both paket counted
  assert.equal(r.totals.earnedIdr, 300_000);
  assert.equal(r.totals.lineCount, 2);
});

test('renderRangeStatementBuffer: excludes komisi outside window', async (t) => {
  const tag = makeTag('s161-window');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '500000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2025-12-15') },  // out of window
  });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-02-15') },
  });

  const r = await renderRangeStatementBuffer({
    agentId: agentUser.agent.id, from: '2026-01-01', to: '2026-03-31',
  });
  assert.equal(r.totals.earnedIdr, 100_000);
});

test('renderRangeStatementBuffer: range > 90 days → RANGE_TOO_WIDE', async (t) => {
  const tag = makeTag('s161-wide');
  const agentUser = await tempAgent(t, tag);
  await assert.rejects(
    () => renderRangeStatementBuffer({
      agentId: agentUser.agent.id, from: '2026-01-01', to: '2026-12-31',
    }),
    (err) => err instanceof HttpError && err.code === 'RANGE_TOO_WIDE',
  );
});

test('renderRangeStatementBuffer: to < from → BAD_RANGE_ORDER', async (t) => {
  const tag = makeTag('s161-order');
  const agentUser = await tempAgent(t, tag);
  await assert.rejects(
    () => renderRangeStatementBuffer({
      agentId: agentUser.agent.id, from: '2026-03-31', to: '2026-01-01',
    }),
    (err) => err instanceof HttpError && err.code === 'BAD_RANGE_ORDER',
  );
});

test('renderRangeStatementBuffer: malformed dates → BAD_DATE', async (t) => {
  const tag = makeTag('s161-malformed');
  const agentUser = await tempAgent(t, tag);
  await assert.rejects(
    () => renderRangeStatementBuffer({
      agentId: agentUser.agent.id, from: 'not-a-date', to: '2026-03-31',
    }),
    (err) => err instanceof HttpError && err.code === 'BAD_DATE',
  );
});

test('renderRangeStatementBuffer: missing args rejected', async () => {
  await assert.rejects(
    () => renderRangeStatementBuffer({ from: '2026-01-01', to: '2026-03-31' }),
    (err) => err instanceof HttpError && err.code === 'BAD_AGENT',
  );
  await assert.rejects(
    () => renderRangeStatementBuffer({ agentId: 'x', from: '2026-01-01' }),
    (err) => err instanceof HttpError && err.code === 'BAD_RANGE',
  );
});

test('renderRangeStatementBuffer: 404 on unknown agent', async () => {
  await assert.rejects(
    () => renderRangeStatementBuffer({
      agentId: 'no-such-agent', from: '2026-01-01', to: '2026-01-31',
    }),
    (err) => err instanceof HttpError && err.code === 'AGENT_NOT_FOUND',
  );
});
