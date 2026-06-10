// Stage 160 — diagonal "PREVIEW · TIDAK KANONIK" watermark on the
// S159 dispute-resolution PDF path. Canonical S150 monthly path
// renders without the overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  renderStatementPdfBuffer, renderPaketScopedStatementBuffer,
  generateAgentStatement,
} from '../src/services/komisiStatement.js';
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
    await db.komisiStatement.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

// PDF byte streams are zlib-compressed, so literal-string matching
// isn't reliable. We compare buffer SIZES — a watermarked PDF carries
// the rotated 72pt text + graphics state save/restore, which adds
// hundreds of bytes even after compression. Identical input + identical
// timing gives a stable diff.

test('renderStatementPdfBuffer: with vs without watermark — sizes differ', async () => {
  const sharedInput = {
    agent: { displayName: 'Test Agent', slug: 't' },
    periodYM: '2026-05',
    lines: [],
    totals: { earnedIdr: 0, paidIdr: 0, lineCount: 0 },
  };
  const plain = await renderStatementPdfBuffer({ ...sharedInput });
  const marked = await renderStatementPdfBuffer({
    ...sharedInput,
    watermark: 'PREVIEW · TIDAK KANONIK',
  });
  assert.equal(plain.slice(0, 4).toString(), '%PDF');
  assert.equal(marked.slice(0, 4).toString(), '%PDF');
  assert.ok(marked.length > plain.length,
    `watermarked PDF (${marked.length}B) should be larger than plain (${plain.length}B)`);
  // Sanity: difference is non-trivial — at least 200 bytes
  assert.ok(marked.length - plain.length > 200,
    'size delta confirms watermark content actually rendered');
});

test('renderPaketScopedStatementBuffer: includes watermark (S159 path)', async (t) => {
  const tag = makeTag('s160-scope');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '50000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });
  // Compare paket-scoped (watermarked) vs same shape rendered without watermark
  const scoped = await renderPaketScopedStatementBuffer({
    agentId: agentUser.agent.id, periodYM: '2026-05', paketId: paket.id,
  });
  const plain = await renderStatementPdfBuffer({
    agent: { displayName: 'Test Agent', slug: tag },
    periodYM: '2026-05',
    lines: scoped.totals ? [{
      id: 'x', amount: { toString: () => '50000' }, status: 'EARNED',
      earnedAt: new Date('2026-05-10'),
      booking: { bookingNo: 'X', jemaah: { fullName: 'Y' } },
    }] : [],
    totals: scoped.totals,
  });
  assert.ok(scoped.buffer.length > plain.length,
    'paket-scoped (with watermark) should be larger than equivalent plain render');
});

test('generateAgentStatement: canonical render produces smaller PDF (no watermark)', async (t) => {
  const tag = makeTag('s160-canonical');
  const agentUser = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.komisi.create({
    data: { agentId: agentUser.agent.id, bookingId: booking.id,
      amount: '50000', currency: 'IDR', status: 'EARNED',
      earnedAt: new Date('2026-05-10') },
  });
  const canonical = await generateAgentStatement({
    agentId: agentUser.agent.id, periodYM: '2026-05',
  });
  t.after(() => { try { if (canonical.pdfPath) rmSync(canonical.pdfPath); } catch {} });
  const scoped = await renderPaketScopedStatementBuffer({
    agentId: agentUser.agent.id, periodYM: '2026-05', paketId: paket.id,
  });
  const { promises: fsp } = await import('node:fs');
  const canonicalBuf = await fsp.readFile(canonical.pdfPath);
  // Scoped path adds: watermark + adminNote block — both absent on
  // canonical. So scoped should be larger.
  assert.ok(scoped.buffer.length > canonicalBuf.length,
    `scoped (with watermark + adminNote) (${scoped.buffer.length}B) > canonical (${canonicalBuf.length}B)`);
});
