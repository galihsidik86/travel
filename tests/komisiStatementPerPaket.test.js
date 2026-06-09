// Stage 159 — per-paket scoped komisi statement for dispute resolution.
// Transient: doesn't persist KomisiStatement row, doesn't fire notif.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  getStatementLines, renderPaketScopedStatementBuffer,
} from '../src/services/komisiStatement.js';
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
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('getStatementLines: paketId filter only returns matching paket', async (t) => {
  const tag = makeTag('s159-filter');
  const agentUser = await tempAgent(t, tag);
  const paketA = await tempPaket(t, `${tag}-A`);
  const paketB = await tempPaket(t, `${tag}-B`);
  const jem = await tempJemaah(t, tag);
  const bookingA = await tempBooking({ paket: paketA, jemaahProfileId: jem.jemaah.id });
  const bookingB = await tempBooking({ paket: paketB, jemaahProfileId: jem.jemaah.id });

  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: bookingA.id,
      amount: '100000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: bookingB.id,
      amount: '200000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-12') },
  });

  // Filter to paket A only
  const r = await getStatementLines({
    agentId: agentUser.agent.id, periodYM: '2026-05', paketId: paketA.id,
  });
  assert.equal(r.totals.earnedIdr, 100_000);
  assert.equal(r.totals.lineCount, 1);
  assert.equal(r.lines[0].booking.paket.slug, paketA.slug);
});

test('getStatementLines: no paketId → returns all (back-compat)', async (t) => {
  const tag = makeTag('s159-default');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '50000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });

  const r = await getStatementLines({ agentId: agentUser.agent.id, periodYM: '2026-05' });
  assert.ok(r.totals.earnedIdr >= 50_000);
});

test('renderPaketScopedStatementBuffer: produces PDF without persisting row', async (t) => {
  const tag = makeTag('s159-render');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '75000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });

  const result = await renderPaketScopedStatementBuffer({
    agentId: agentUser.agent.id, periodYM: '2026-05', paketId: paket.id,
  });
  // PDF magic bytes
  assert.equal(result.buffer.slice(0, 4).toString(), '%PDF');
  // Totals reflect scoped data
  assert.equal(result.totals.earnedIdr, 75_000);

  // No KomisiStatement row created
  const rows = await db.komisiStatement.findMany({
    where: { agentId: agentUser.agent.id, periodYM: '2026-05' },
  });
  assert.equal(rows.length, 0, 'transient — no row persisted');
});

test('renderPaketScopedStatementBuffer: validates required args', async () => {
  await assert.rejects(
    () => renderPaketScopedStatementBuffer({ periodYM: '2026-05', paketId: 'x' }),
    (err) => err instanceof HttpError && err.code === 'BAD_AGENT',
  );
  await assert.rejects(
    () => renderPaketScopedStatementBuffer({ agentId: 'a', periodYM: '2026/05', paketId: 'x' }),
    (err) => err instanceof HttpError && err.code === 'BAD_PERIOD',
  );
  await assert.rejects(
    () => renderPaketScopedStatementBuffer({ agentId: 'a', periodYM: '2026-05' }),
    (err) => err instanceof HttpError && err.code === 'BAD_PAKET',
  );
});

test('renderPaketScopedStatementBuffer: 404 on unknown agent', async (t) => {
  const tag = makeTag('s159-unknown');
  const paket = await tempPaket(t, tag);
  await assert.rejects(
    () => renderPaketScopedStatementBuffer({
      agentId: 'cmq-unknown-agent', periodYM: '2026-05', paketId: paket.id,
    }),
    (err) => err instanceof HttpError && err.code === 'AGENT_NOT_FOUND',
  );
});
