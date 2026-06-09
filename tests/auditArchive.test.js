// Stage 139 — AuditLog cold-storage archive. Rows older than the
// retention window stream to a gzipped CSV under private/audit-archive/
// then get deleted from DB. Wired into the weekly prune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import { archiveAuditLog } from '../src/services/auditLog.js';
import { pruneRetentionWindows } from '../src/services/retention.js';
import { audit } from '../src/lib/audit.js';

function makeTempArchiveDir(t) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'audit-archive-test-'));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

test('archiveAuditLog: empty DB → writes no file, returns archived=0', async (t) => {
  const dir = makeTempArchiveDir(t);
  // Use a future cutoff (negative retention) so NO rows match
  const result = await archiveAuditLog({
    now: new Date(),
    retentionDays: 10_000,  // 27 years — nothing in test DB qualifies
    dir,
  });
  assert.equal(result.archived, 0);
  assert.equal(result.filePath, null);
});

test('archiveAuditLog: streams old rows to gzip + deletes from DB', async (t) => {
  const tag = makeTag('s139-archive');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const dir = makeTempArchiveDir(t);

  // Seed 5 audit rows under our tag's actor — backdate via Prisma raw
  // since the audit() helper stamps createdAt to now.
  const now = new Date();
  const oldDate = new Date(now.getTime() - 800 * 24 * 60 * 60 * 1000);  // ~2.2y ago
  for (let i = 0; i < 5; i++) {
    await audit({
      req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
      action: 'CREATE', entity: 'Webhook', entityId: `${tag}-${i}`,
      after: { idx: i },
    });
  }
  // Force backdate on the rows we just inserted
  await db.auditLog.updateMany({
    where: { entity: 'Webhook', entityId: { startsWith: tag } },
    data: { createdAt: oldDate },
  });

  const result = await archiveAuditLog({ now, retentionDays: 730, dir });
  assert.ok(result.archived >= 5, `archived ≥ 5 (got ${result.archived})`);
  assert.ok(result.filePath);
  assert.ok(existsSync(result.filePath), 'gzip file created');
  assert.ok(result.sizeBytes > 0);

  // Decompress + verify CSV shape
  const buf = readFileSync(result.filePath);
  const csv = gunzipSync(buf).toString('utf8');
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'UTF-8 BOM intact through gzip');
  assert.match(csv, /^.id,createdAt,action,entity,entityId,actorEmail,actorRole,ip,userAgent,before,after/);
  // Our 5 rows appear in the body
  const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean);
  const ourLines = lines.filter((l) => l.includes(tag));
  assert.equal(ourLines.length, 5);

  // DB rows GONE (the whole point — bounded growth)
  const remaining = await db.auditLog.count({
    where: { entity: 'Webhook', entityId: { startsWith: tag } },
  });
  assert.equal(remaining, 0, 'archived rows deleted from DB');
});

test('archiveAuditLog: rows NEWER than cutoff are untouched', async (t) => {
  const tag = makeTag('s139-recent');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const dir = makeTempArchiveDir(t);

  // Recent audit row (today)
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-recent`,
    after: { recent: true },
  });
  t.after(() => db.auditLog.deleteMany({
    where: { entity: 'Webhook', entityId: { startsWith: tag } },
  }));

  const result = await archiveAuditLog({ now: new Date(), retentionDays: 730, dir });
  // The recent row must NOT have been archived
  const remaining = await db.auditLog.count({
    where: { entity: 'Webhook', entityId: `${tag}-recent` },
  });
  assert.equal(remaining, 1, 'recent row survived');
  // archived count may be > 0 from other test-leftover old rows; just
  // verify our recent row's entityId did NOT make it into the archive.
  if (result.filePath && result.archived > 0) {
    const csv = gunzipSync(readFileSync(result.filePath)).toString('utf8');
    assert.doesNotMatch(csv, new RegExp(`${tag}-recent`));
  }
});

test('archiveAuditLog: filename includes run timestamp + cutoff date', async (t) => {
  const tag = makeTag('s139-name');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const dir = makeTempArchiveDir(t);

  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-x`,
    after: {},
  });
  await db.auditLog.updateMany({
    where: { entity: 'Webhook', entityId: `${tag}-x` },
    data: { createdAt: new Date('2023-01-01T00:00:00.000Z') },
  });

  const now = new Date('2026-06-09T10:30:00.000Z');
  const result = await archiveAuditLog({ now, retentionDays: 730, dir });
  assert.ok(result.filePath);
  // Filename pattern: audit_<YYYY-MM-DD>_<HHMMSS>_pre_<cutoff>.csv.gz
  assert.match(result.filePath, /audit_2026-06-09_\d{6}_pre_\d{4}-\d{2}-\d{2}\.csv\.gz$/);
});

test('pruneRetentionWindows: invokes auditArchive when threshold met', async (t) => {
  const tag = makeTag('s139-prune');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const dir = makeTempArchiveDir(t);

  // Seed an old row
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-old`,
    after: {},
  });
  await db.auditLog.updateMany({
    where: { entity: 'Webhook', entityId: `${tag}-old` },
    data: { createdAt: new Date('2022-01-01') },
  });

  // Direct invocation — windows={auditArchiveDays:730, ...} passes
  // through to archiveAuditLog. Other prune buckets execute too but
  // with their defaults so they're no-ops on the small test data.
  const result = await pruneRetentionWindows({
    req: fakeReq,
    actor: { email: 'test-runner' },
    now: new Date('2026-06-09'),
    windows: { auditArchiveDays: 730 },
  });

  assert.ok(result.auditArchive);
  // Our seeded row should have been archived (count ≥ 1; other tests
  // may have left leftovers that also qualified)
  assert.ok(result.auditArchive.deleted >= 1);
  // Our seed row is gone from DB
  const remaining = await db.auditLog.count({
    where: { entity: 'Webhook', entityId: `${tag}-old` },
  });
  assert.equal(remaining, 0);
});

test('pruneRetentionWindows: auditArchiveDays=0 disables archive (back-compat opt-out)', async (t) => {
  const tag = makeTag('s139-disabled');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-keep`,
    after: {},
  });
  await db.auditLog.updateMany({
    where: { entity: 'Webhook', entityId: `${tag}-keep` },
    data: { createdAt: new Date('2020-01-01') },  // very old
  });
  t.after(() => db.auditLog.deleteMany({
    where: { entity: 'Webhook', entityId: `${tag}-keep` },
  }));

  const result = await pruneRetentionWindows({
    req: fakeReq, actor: { email: 'test-runner' },
    now: new Date('2026-06-09'),
    windows: { auditArchiveDays: 0 },
  });

  assert.equal(result.auditArchive.archived, 0, 'disabled → no-op');
  // Row still in DB
  const stillThere = await db.auditLog.count({
    where: { entity: 'Webhook', entityId: `${tag}-keep` },
  });
  assert.equal(stillThere, 1);
});
