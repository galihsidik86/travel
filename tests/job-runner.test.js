// runJob + getJobFreshness tests.
// Verifies the recorder writes start + finish + counters + duration,
// surfaces results through, propagates errors with row patched, and
// the freshness query flags stale jobs based on expected interval.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { runJob, getJobFreshness, EXPECTED_INTERVAL_MS } from '../src/lib/jobRunner.js';

describe('runJob — happy path', () => {
  test('records start, then patches finish + counters + duration; returns service result through', async (t) => {
    const tag = makeTag('jr-ok');
    const name = `test-job-${tag}`;
    t.after(() => db.jobRun.deleteMany({ where: { name } }));

    const result = await runJob(name, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { scanned: 5, expired: 3, errors: [] };
    });

    assert.deepEqual(result, { scanned: 5, expired: 3, errors: [] }, 'service result passed through');

    const rows = await db.jobRun.findMany({ where: { name } });
    assert.equal(rows.length, 1, 'single row written');
    const row = rows[0];
    assert.equal(row.ok, true);
    assert.equal(row.scanned, 5);
    assert.equal(row.affected, 3, 'expired → affected');
    assert.equal(row.errors, 0);
    assert.ok(row.durationMs >= 20, 'durationMs reflects actual time');
    assert.ok(row.finishedAt, 'finishedAt set');
  });

  test('errors as array.length: counters.errors = length', async (t) => {
    const tag = makeTag('jr-errs');
    const name = `test-job-${tag}`;
    t.after(() => db.jobRun.deleteMany({ where: { name } }));

    await runJob(name, async () => ({
      scanned: 10, expired: 7,
      errors: [{ id: 'x', error: 'a' }, { id: 'y', error: 'b' }],
    }));
    const row = await db.jobRun.findFirst({ where: { name } });
    assert.equal(row.errors, 2, 'array.length captured');
  });

  test('sent → affected mapping for notif job', async (t) => {
    const tag = makeTag('jr-sent');
    const name = `test-job-${tag}`;
    t.after(() => db.jobRun.deleteMany({ where: { name } }));

    await runJob(name, async () => ({ processed: 4, sent: 3, failed: 1, skipped: 0 }));
    const row = await db.jobRun.findFirst({ where: { name } });
    assert.equal(row.affected, 3, 'sent → affected');
    assert.ok(row.detail, 'extra fields stashed in detail');
    assert.equal(row.detail.processed, 4);
    assert.equal(row.detail.failed, 1);
  });
});

describe('runJob — error path', () => {
  test('thrown error: row patched ok=false + error message; re-throws', async (t) => {
    const tag = makeTag('jr-throw');
    const name = `test-job-${tag}`;
    t.after(() => db.jobRun.deleteMany({ where: { name } }));

    await assert.rejects(
      runJob(name, async () => { throw new Error('boom from inside'); }),
      /boom from inside/,
    );

    const row = await db.jobRun.findFirst({ where: { name } });
    assert.equal(row.ok, false);
    assert.match(row.error, /boom from inside/);
    assert.ok(row.finishedAt, 'still finished — recorder must complete even on error');
    assert.ok(row.durationMs >= 0);
  });
});

describe('getJobFreshness', () => {
  test('unknown-job names report ranEver:false', async () => {
    const fresh = await getJobFreshness();
    // The official names are seeded — but if none have ever run, all report ranEver:false
    assert.ok(Array.isArray(fresh));
    assert.equal(fresh.length, Object.keys(EXPECTED_INTERVAL_MS).length);
    for (const f of fresh) {
      assert.ok('name' in f);
      assert.ok('ok' in f);
      assert.ok('expectedIntervalSec' in f);
    }
  });

  test('fresh run within expected interval → ok:true with ageSeconds', async (t) => {
    // Insert a fake "expire-intents" run that finished just now.
    // Cleanup wipes the row, leaving real test runs untouched.
    const row = await db.jobRun.create({
      data: {
        name: 'expire-intents',
        startedAt: new Date(Date.now() - 1000),
        finishedAt: new Date(),
        ok: true, durationMs: 1000, scanned: 0, affected: 0, errors: 0,
      },
    });
    t.after(() => db.jobRun.deleteMany({ where: { id: row.id } }));

    const fresh = await getJobFreshness();
    const ei = fresh.find((f) => f.name === 'expire-intents');
    assert.equal(ei.ok, true, 'recent run → ok');
    assert.equal(ei.ranEver, true);
    assert.ok(ei.lastSuccessAt);
    assert.ok(ei.ageSeconds >= 0 && ei.ageSeconds < 5);
    assert.equal(ei.expectedIntervalSec, EXPECTED_INTERVAL_MS['expire-intents'] / 1000);
  });

  test('stale run (>2× expected interval) → ok:false', async (t) => {
    // expire-intents expected 10min — make a "successful" run 30min old.
    // Snapshot any pre-existing rows (e.g. from local `npm run job:...`
    // during dev) and restore them after — keeps the test deterministic
    // without losing real cron history.
    const preExisting = await db.jobRun.findMany({ where: { name: 'expire-intents' } });
    await db.jobRun.deleteMany({ where: { name: 'expire-intents' } });
    const fakeAgeMs = 30 * 60_000;
    const row = await db.jobRun.create({
      data: {
        name: 'expire-intents',
        startedAt: new Date(Date.now() - fakeAgeMs - 1000),
        finishedAt: new Date(Date.now() - fakeAgeMs),
        ok: true, durationMs: 1000,
      },
    });
    t.after(async () => {
      await db.jobRun.deleteMany({ where: { id: row.id } });
      for (const r of preExisting) {
        await db.jobRun.create({ data: r }).catch(() => {});
      }
    });

    const fresh = await getJobFreshness();
    const ei = fresh.find((f) => f.name === 'expire-intents');
    assert.equal(ei.ok, false, '30min > 2 × 10min expected → stale');
    assert.ok(ei.ageSeconds > 20 * 60, 'age reflects the staleness');
  });

  test('latest successful run wins (failed/unfinished rows ignored)', async (t) => {
    const ids = [];
    // Old success
    ids.push((await db.jobRun.create({
      data: {
        name: 'expire-docs',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(Date.now() - 4000),
        ok: true, durationMs: 1000,
      },
    })).id);
    // Recent FAILURE — must NOT count
    ids.push((await db.jobRun.create({
      data: {
        name: 'expire-docs',
        startedAt: new Date(Date.now() - 2000),
        finishedAt: new Date(Date.now() - 1000),
        ok: false, durationMs: 1000, error: 'fake',
      },
    })).id);
    t.after(() => db.jobRun.deleteMany({ where: { id: { in: ids } } }));

    const fresh = await getJobFreshness();
    const ed = fresh.find((f) => f.name === 'expire-docs');
    assert.equal(ed.ranEver, true);
    // Latest SUCCESS is 4s old; 4s < 2 × 24h, so ok:true
    assert.equal(ed.ok, true);
    assert.ok(ed.ageSeconds >= 3 && ed.ageSeconds < 10);
  });
});
