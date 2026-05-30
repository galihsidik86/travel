// Stage 18 — clonePaket: copy hotels/days/prices into a fresh DRAFT.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempUser, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { clonePaket } from '../src/services/paketAdmin.js';

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
    await db.agentPaketKomisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function decoratePaket(paket) {
  await db.paketHotel.create({
    data: { paketId: paket.id, city: 'MADINAH', name: 'Hotel Test', stars: 5, nights: 4 },
  });
  await db.paketHotel.create({
    data: { paketId: paket.id, city: 'MEKKAH', name: 'Hotel Test 2', stars: 5, nights: 5 },
  });
  await db.paketHarga.create({
    data: { paketId: paket.id, kelas: 'VVIP', priceIdr: '50000000', isFeatured: true },
  });
}

async function cleanupCloned(t, slug) {
  t.after(async () => {
    const c = await db.paket.findUnique({ where: { slug } });
    if (!c) return;
    await db.agentPaketKomisi.deleteMany({ where: { paketId: c.id } });
    await db.paketHotel.deleteMany({ where: { paketId: c.id } });
    await db.paketDay.deleteMany({ where: { paketId: c.id } });
    await db.paketHarga.deleteMany({ where: { paketId: c.id } });
    await db.paket.delete({ where: { id: c.id } });
  });
}

const ctx = { req: fakeReq, actor: systemActor };

describe('clonePaket — happy path', () => {
  test('copies hotels + days + prices; new paket is DRAFT with kursiTerisi=0', async (t) => {
    const tag = makeTag('clone-happy');
    const source = await tempPaket(t, `src-${tag}`, { dayCount: 3 });
    await decoratePaket(source);
    const newSlug = `dst-${tag}`;
    await cleanupCloned(t, newSlug);

    const cloned = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: {
        newSlug, newTitle: 'Cloned Paket',
        newDepartureDate: '2027-03-15',
      },
    });

    assert.equal(cloned.status, 'DRAFT', 'always lands in DRAFT');
    assert.equal(cloned.kursiTerisi, 0, 'kursiTerisi reset');
    assert.equal(cloned.title, 'Cloned Paket');

    const [hotels, days, prices] = await Promise.all([
      db.paketHotel.findMany({ where: { paketId: cloned.id } }),
      db.paketDay.findMany({ where: { paketId: cloned.id } }),
      db.paketHarga.findMany({ where: { paketId: cloned.id } }),
    ]);
    assert.equal(hotels.length, 2, 'both hotels copied');
    assert.equal(days.length, 3, 'all 3 days copied');
    assert.equal(prices.length, 2, '1 from tempPaket + 1 from decorate = 2');
  });

  test('returnDate defaults from source.durationDays when not given', async (t) => {
    const tag = makeTag('clone-ret');
    const source = await tempPaket(t, `src-${tag}`);    // durationDays=10 from helper
    const newSlug = `dst-${tag}`;
    await cleanupCloned(t, newSlug);

    const cloned = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: { newSlug, newTitle: 'New Paket Title', newDepartureDate: '2027-04-01' },
    });
    const expectedReturn = new Date('2027-04-11').toISOString().slice(0, 10);
    assert.equal(cloned.returnDate.toISOString().slice(0, 10), expectedReturn, 'auto = dep + 10');
    assert.equal(cloned.durationDays, 10);
  });

  test('explicit newReturnDate recomputes durationDays', async (t) => {
    const tag = makeTag('clone-explicit');
    const source = await tempPaket(t, `src-${tag}`);
    const newSlug = `dst-${tag}`;
    await cleanupCloned(t, newSlug);

    const cloned = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: {
        newSlug, newTitle: 'Cloned Y',
        newDepartureDate: '2027-04-01', newReturnDate: '2027-04-15',
      },
    });
    assert.equal(cloned.durationDays, 14);
  });
});

describe('clonePaket — agent overrides', () => {
  test('default skips AgentPaketKomisi; opt-in copies them', async (t) => {
    const tag = makeTag('clone-agen');
    const source = await tempPaket(t, `src-${tag}`);
    const agent = await tempAgent(t, tag);
    await db.agentPaketKomisi.create({
      data: { agentId: agent.agent.id, paketId: source.id, rate: 0.15 },
    });

    const skipSlug = `skip-${tag}`;
    const copySlug = `copy-${tag}`;
    await cleanupCloned(t, skipSlug);
    await cleanupCloned(t, copySlug);

    const skip = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: { newSlug: skipSlug, newTitle: 'Skip', newDepartureDate: '2027-05-01' },
    });
    const skipped = await db.agentPaketKomisi.findMany({ where: { paketId: skip.id } });
    assert.equal(skipped.length, 0, 'default: no agent overrides copied');

    const copy = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: {
        newSlug: copySlug, newTitle: 'Copy', newDepartureDate: '2027-06-01',
        includeAgentOverrides: true,
      },
    });
    const copied = await db.agentPaketKomisi.findMany({ where: { paketId: copy.id } });
    assert.equal(copied.length, 1, 'opt-in: matrix row copied');
    assert.equal(Number(copied[0].rate.toString()), 0.15);
  });
});

describe('clonePaket — guards', () => {
  test('slug collision → 409 SLUG_TAKEN', async (t) => {
    const tag = makeTag('clone-clash');
    const source = await tempPaket(t, `src-${tag}`);
    const clashSlug = `clash-${tag}`;
    const _clash = await tempPaket(t, clashSlug);

    await assert.rejects(
      () => clonePaket({
        ...ctx, sourceSlug: source.slug,
        input: { newSlug: clashSlug, newTitle: 'Clash Title', newDepartureDate: '2027-04-01' },
      }),
      (err) => err.status === 409 && err.code === 'SLUG_TAKEN',
    );
  });

  test('source not found → 404', async () => {
    await assert.rejects(
      () => clonePaket({
        ...ctx, sourceSlug: 'paket-yang-tidak-ada-xyz',
        input: { newSlug: 'new-' + makeTag('miss'), newTitle: 'Missing Source', newDepartureDate: '2027-04-01' },
      }),
      (err) => err.status === 404 && err.code === 'PAKET_NOT_FOUND',
    );
  });

  test('invalid slug shape → 400 BAD_INPUT', async (t) => {
    const tag = makeTag('clone-shape');
    const source = await tempPaket(t, `src-${tag}`);

    await assert.rejects(
      () => clonePaket({
        ...ctx, sourceSlug: source.slug,
        input: { newSlug: 'Invalid SLUG With Spaces', newTitle: 'Bad Slug Test', newDepartureDate: '2027-04-01' },
      }),
      (err) => err.status === 400,
    );
  });

  test('audit row written with clonedFromSlug marker', async (t) => {
    const tag = makeTag('clone-audit');
    const source = await tempPaket(t, `src-${tag}`);
    const newSlug = `dst-${tag}`;
    await cleanupCloned(t, newSlug);

    const cloned = await clonePaket({
      ...ctx, sourceSlug: source.slug,
      input: { newSlug, newTitle: 'Audit Test', newDepartureDate: '2027-04-01' },
    });
    const row = await db.auditLog.findFirst({
      where: { entity: 'Paket', entityId: cloned.id, action: 'CREATE' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(row, 'audit row exists');
    assert.equal(row.after?.cloned, true);
    assert.equal(row.after?.clonedFromSlug, source.slug);
  });
});
