// Stage 324 — crew-authored paket announcement via createAnnouncement.
// Service-level test: passing a MUTHAWWIF actor creates an announcement
// with authorId set, and fan-out is fire-and-forget (no failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempMuthawwif, fakeReq } from './_helpers.js';
import { createAnnouncement } from '../src/services/paketAnnouncements.js';

async function tempPaketBasic(t, tag) {
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 9 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S324 — MUTHAWWIF actor creates announcement with authorId', async (t) => {
  const tag = makeTag('s324a');
  const crew = await tempMuthawwif(t, `${tag}-crew`);
  const paket = await tempPaketBasic(t, `${tag}-pkt`);

  const actor = { id: crew.id, email: crew.email, role: 'MUTHAWWIF' };
  const row = await createAnnouncement({
    req: fakeReq, actor, paketId: paket.id,
    input: {
      title: 'Bus telat 30 menit',
      body: 'Kumpul di lobby pukul 16:00 ya. Maaf karena macet.',
    },
  });
  assert.equal(row.authorId, crew.id);
  assert.equal(row.title, 'Bus telat 30 menit');
  assert.equal(row.paketId, paket.id);

  // Verify the audit row stamped MUTHAWWIF as the actor
  const audit = await db.auditLog.findFirst({
    where: { entity: 'PaketAnnouncement', entityId: row.id },
    select: { actorEmail: true, actorRole: true },
  });
  assert.ok(audit);
  assert.equal(audit.actorEmail, crew.email);
  assert.equal(audit.actorRole, 'MUTHAWWIF');
});

test('S324 — input schema rejects empty body', async (t) => {
  const tag = makeTag('s324b');
  const crew = await tempMuthawwif(t, `${tag}-crew`);
  const paket = await tempPaketBasic(t, `${tag}-pkt`);
  const actor = { id: crew.id, email: crew.email, role: 'MUTHAWWIF' };

  await assert.rejects(
    createAnnouncement({
      req: fakeReq, actor, paketId: paket.id,
      input: { title: 'Test', body: '' },
    }),
  );
});
