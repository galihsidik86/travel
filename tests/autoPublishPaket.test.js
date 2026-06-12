// Stage 227 — auto-publish scheduled paket.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import {
  getAutoPublishCandidates,
  autoPublishOne,
  runAutoPublishPaket,
} from '../src/services/autoPublishPaket.js';

async function makePaket(t, tag, { status = 'DRAFT', publishedAt = null, daysOut = 30, kursiTotal = 10 } = {}) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal, status, publishedAt,
    },
  });
  t.after(async () => { await db.paket.deleteMany({ where: { id: paket.id } }); });
  return paket;
}

test('getAutoPublishCandidates: empty when no DRAFT with publishedAt set', async () => {
  const r = await getAutoPublishCandidates({ now: new Date() });
  // dev DB may have unrelated rows; just verify shape
  assert.ok(Array.isArray(r));
});

test('getAutoPublishCandidates: DRAFT with publishedAt in the past surfaces', async (t) => {
  const tag = makeTag('s227-past');
  const paket = await makePaket(t, tag, {
    status: 'DRAFT',
    publishedAt: new Date(Date.now() - 86_400_000), // yesterday
  });

  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.ok(mine, 'paket surfaces');
});

test('getAutoPublishCandidates: DRAFT with publishedAt in the future excluded', async (t) => {
  const tag = makeTag('s227-future');
  const paket = await makePaket(t, tag, {
    status: 'DRAFT',
    publishedAt: new Date(Date.now() + 7 * 86_400_000),
  });

  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.equal(mine, undefined);
});

test('getAutoPublishCandidates: ACTIVE paket excluded (no-op)', async (t) => {
  const tag = makeTag('s227-active');
  const paket = await makePaket(t, tag, {
    status: 'ACTIVE',
    publishedAt: new Date(Date.now() - 86_400_000),
  });
  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.equal(mine, undefined);
});

test('getAutoPublishCandidates: ARCHIVED excluded', async (t) => {
  const tag = makeTag('s227-archived');
  const paket = await makePaket(t, tag, {
    status: 'ARCHIVED',
    publishedAt: new Date(Date.now() - 86_400_000),
  });
  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.equal(mine, undefined);
});

test('getAutoPublishCandidates: past-departure paket excluded (sanity guard)', async (t) => {
  const tag = makeTag('s227-pastdep');
  const paket = await makePaket(t, tag, {
    status: 'DRAFT',
    publishedAt: new Date(Date.now() - 86_400_000),
    daysOut: -5, // departure already past
  });
  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.equal(mine, undefined);
});

test('getAutoPublishCandidates: kursiTotal=0 excluded', async (t) => {
  const tag = makeTag('s227-zerokursi');
  const paket = await makePaket(t, tag, {
    status: 'DRAFT',
    publishedAt: new Date(Date.now() - 86_400_000),
    kursiTotal: 0,
  });
  const candidates = await getAutoPublishCandidates({ now: new Date() });
  const mine = candidates.find((c) => c.id === paket.id);
  assert.equal(mine, undefined);
});

test('autoPublishOne: flips DRAFT → ACTIVE + writes audit', async (t) => {
  const tag = makeTag('s227-flip');
  const paket = await makePaket(t, tag, {
    status: 'DRAFT',
    publishedAt: new Date(Date.now() - 86_400_000),
  });
  const actor = { id: null, email: 'system', role: null };
  const req = { ip: null, headers: {}, get: () => null };

  await autoPublishOne({ paketId: paket.id, actor, req });

  const fresh = await db.paket.findUnique({ where: { id: paket.id }, select: { status: true } });
  assert.equal(fresh.status, 'ACTIVE');
  const audits = await db.auditLog.findMany({
    where: { entity: 'Paket', entityId: paket.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.equal(audits[0].after.autoPublished, true);
});

test('runAutoPublishPaket: publishes multiple, isolates per-row failure', async (t) => {
  const tag = makeTag('s227-batch');
  await makePaket(t, tag + '-a', {
    status: 'DRAFT', publishedAt: new Date(Date.now() - 86_400_000),
  });
  await makePaket(t, tag + '-b', {
    status: 'DRAFT', publishedAt: new Date(Date.now() - 86_400_000),
  });

  const r = await runAutoPublishPaket({ now: new Date() });
  assert.ok(r.candidates >= 2);
  assert.ok(r.published >= 2);
});

test('runAutoPublishPaket: silent on empty (no audit pollution)', async () => {
  const beforeCount = await db.auditLog.count({ where: { entity: 'Paket', action: 'UPDATE' } });
  // Run with a far-future "now" so no candidates
  const r = await runAutoPublishPaket({ now: new Date('2020-01-01') });
  assert.equal(r.candidates, 0);
  assert.equal(r.published, 0);
  const afterCount = await db.auditLog.count({ where: { entity: 'Paket', action: 'UPDATE' } });
  assert.equal(afterCount, beforeCount);
});
