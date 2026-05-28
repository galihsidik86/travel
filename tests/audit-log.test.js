// Audit log service — list filters + daily-activity sparkline shape.
// Both functions are read-only over the append-only AuditLog table; no
// fixture cleanup needed beyond the rows we ourselves write.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { db } from './_helpers.js';
import { listAudits, getAuditActivity } from '../src/services/auditLog.js';

const TAG = `auditlog-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const TAG_EMAIL = `${TAG}@example.test`;

// Seed three rows: two today, one back-dated 5 days. Distinct actions so
// per-action totals don't collide with other test runs sharing the dev DB.
const writeRow = (overrides = {}) => db.auditLog.create({
  data: {
    entity: 'User',
    entityId: TAG,
    action: 'UPDATE',
    actorEmail: TAG_EMAIL,
    actorRole: 'OWNER',
    ip: '127.0.0.1',
    userAgent: 'test',
    before: {},
    after: { tag: TAG },
    ...overrides,
  },
});

after(async () => {
  await db.auditLog.deleteMany({ where: { actorEmail: TAG_EMAIL } });
});

describe('getAuditActivity', () => {
  test('default range = 14 days, returns one bucket per day', async () => {
    await writeRow({ action: 'CREATE' });
    await writeRow({ action: 'UPDATE' });
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setUTCDate(fiveDaysAgo.getUTCDate() - 5);
    await writeRow({ action: 'DELETE', createdAt: fiveDaysAgo });

    const activity = await getAuditActivity({ actorEmail: TAG_EMAIL });

    assert.equal(activity.daily.length, 14, 'default range = 14 days');
    assert.equal(activity.rangeDays, 14);
    assert.equal(activity.totalCount, 3, 'three rows visible in 14-day window');
    assert.equal(activity.actionTotals.CREATE, 1);
    assert.equal(activity.actionTotals.UPDATE, 1);
    assert.equal(activity.actionTotals.DELETE, 1);

    // Today bucket holds the two we just wrote
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayBucket = activity.daily.find((d) => d.date === todayKey);
    assert.ok(todayBucket, 'today bucket exists');
    assert.equal(todayBucket.count, 2);
  });

  test('clamps oversized ranges to 90 days', async () => {
    const activity = await getAuditActivity({
      actorEmail: TAG_EMAIL,
      from: '2020-01-01',
      to: '2030-01-01',
    });
    assert.equal(activity.rangeDays, 90, 'clamp prevents unbounded SVG width');
    assert.equal(activity.daily.length, 90);
  });

  test('honors entity + action filter — empty result still produces a full day grid', async () => {
    const activity = await getAuditActivity({
      actorEmail: TAG_EMAIL,
      entity: 'Paket', // we only wrote User rows, so this should be empty
    });
    assert.equal(activity.totalCount, 0);
    assert.equal(activity.daily.length, 14);
    assert.ok(activity.daily.every((d) => d.count === 0), 'all buckets empty');
    assert.deepEqual(activity.actionTotals, {});
  });
});

describe('listAudits', () => {
  test('actorEmail substring filter scopes results', async () => {
    const result = await listAudits({ actorEmail: TAG_EMAIL });
    assert.ok(result.rows.every((r) => r.actorEmail === TAG_EMAIL));
    assert.ok(result.total >= 3, 'sees our seeded rows');
  });
});
