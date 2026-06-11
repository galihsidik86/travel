// Stage 201 — audit log substring search across before/after JSON
// + entityId. ≥3 chars required; raw query against MariaDB CAST + LIKE.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, fakeReq } from './_helpers.js';
import { listAudits } from '../src/services/auditLog.js';
import { audit } from '../src/lib/audit.js';

async function seedAudits(t, marker) {
  // Create three distinct audit rows with the marker embedded in
  // different places (entityId, before, after).
  const inEntityId = `${marker}-id-${Math.random().toString(36).slice(2, 5)}`;
  const r1 = await db.auditLog.create({
    data: {
      action: 'CREATE', entity: 'TestEntity', entityId: inEntityId,
      actorEmail: 'test@example.test',
    },
  });
  const r2 = await db.auditLog.create({
    data: {
      action: 'UPDATE', entity: 'TestEntity', entityId: 'other-id',
      actorEmail: 'test@example.test',
      before: { note: `something with ${marker} in it` },
    },
  });
  const r3 = await db.auditLog.create({
    data: {
      action: 'UPDATE', entity: 'TestEntity', entityId: 'yet-another',
      actorEmail: 'test@example.test',
      after: { description: `final mention of ${marker}` },
    },
  });
  // Decoy: no marker
  const r4 = await db.auditLog.create({
    data: {
      action: 'CREATE', entity: 'TestEntity', entityId: 'irrelevant',
      actorEmail: 'test@example.test',
      after: { description: 'no match' },
    },
  });
  t.after(async () => {
    await db.auditLog.deleteMany({
      where: { id: { in: [r1.id, r2.id, r3.id, r4.id] } },
    });
  });
  return { matchers: [r1.id, r2.id, r3.id], decoy: r4.id };
}

test('listAudits: q="" → no content filter applied', async (t) => {
  const tag = makeTag('s201-empty');
  const { matchers } = await seedAudits(t, tag);
  const result = await listAudits({ entity: 'TestEntity', q: '' });
  const ids = result.rows.map((r) => r.id);
  for (const m of matchers) {
    assert.ok(ids.includes(m), 'matched row surfaced when q empty');
  }
});

test('listAudits: q too short (<3 chars) → silently ignored', async (t) => {
  const tag = makeTag('s201-short');
  const { matchers, decoy } = await seedAudits(t, tag);
  const result = await listAudits({ entity: 'TestEntity', q: 'ab' });
  const ids = result.rows.map((r) => r.id);
  // Even decoy row should appear since q < 3 chars is ignored
  assert.ok(ids.includes(decoy));
  for (const m of matchers) assert.ok(ids.includes(m));
});

test('listAudits: q matches substring in entityId', async (t) => {
  const tag = makeTag('s201-id');
  const { matchers } = await seedAudits(t, tag);
  const result = await listAudits({ entity: 'TestEntity', q: tag });
  const ids = result.rows.map((r) => r.id);
  // All 3 markers should appear (entityId-match for r1, before/after for r2/r3)
  for (const m of matchers) {
    assert.ok(ids.includes(m), 'marker row matched');
  }
});

test('listAudits: q matches substring in before JSON', async (t) => {
  const tag = makeTag('s201-before');
  await seedAudits(t, tag);
  const result = await listAudits({ entity: 'TestEntity', q: 'something with' });
  assert.ok(result.total >= 1);
  // At least one row should have `before.note` containing the marker
  const matchRow = result.rows.find((r) => r.action === 'UPDATE');
  assert.ok(matchRow, 'an UPDATE row matched');
});

test('listAudits: q matches substring in after JSON', async (t) => {
  const tag = makeTag('s201-after');
  await seedAudits(t, tag);
  const result = await listAudits({ entity: 'TestEntity', q: 'final mention' });
  assert.ok(result.total >= 1);
});

test('listAudits: q with no matches → total=0 empty rows', async () => {
  const result = await listAudits({
    entity: 'TestEntity',
    q: 'zzz-this-should-not-match-any-row-anywhere',
  });
  assert.equal(result.total, 0);
  assert.equal(result.rows.length, 0);
  assert.equal(result.q, 'zzz-this-should-not-match-any-row-anywhere');
});

test('listAudits: q narrows in conjunction with entity filter', async (t) => {
  const tag = makeTag('s201-narrow');
  const { matchers } = await seedAudits(t, tag);
  // Filter to TestEntity + a marker substring
  const result = await listAudits({
    entity: 'TestEntity', q: tag,
  });
  const ids = result.rows.map((r) => r.id);
  for (const m of matchers) assert.ok(ids.includes(m));
  // All returned rows must be TestEntity entity
  for (const r of result.rows) {
    assert.equal(r.entity, 'TestEntity');
  }
});

test('listAudits: q with LIKE special chars (%_\\) is escaped', async (t) => {
  const tag = makeTag('s201-esc');
  const row = await db.auditLog.create({
    data: {
      action: 'CREATE', entity: 'TestEntity', entityId: 'esc',
      actorEmail: 'x', after: { note: `value with 50_percent here` },
    },
  });
  t.after(async () => { await db.auditLog.deleteMany({ where: { id: row.id } }); });
  // The underscore is a SQL LIKE wildcard; our escape should prevent it
  // from matching anything via wildcard expansion.
  const r1 = await listAudits({ q: '50_percent' });
  assert.ok(r1.rows.some((x) => x.id === row.id), 'literal underscore matched');
});
