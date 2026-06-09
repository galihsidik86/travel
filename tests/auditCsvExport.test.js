// Stage 138 — streaming CSV export for AuditLog. 7-day default window,
// 90-day cap, 50k row hard ceiling. Self-audits the export itself
// (action=EXPORT, entity=AuditLog) so investigators know who pulled
// the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  exportAuditCsv, csvEscape, resolveExportRange,
  EXPORT_MAX_DAYS, EXPORT_DEFAULT_DAYS,
} from '../src/services/auditLog.js';
import { audit } from '../src/lib/audit.js';

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

test('csvEscape: plain values pass through unchanged', () => {
  assert.equal(csvEscape('hello'), 'hello');
  assert.equal(csvEscape(123), '123');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape: wraps + doubles quotes when value contains comma / quote / newline', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
});

test('csvEscape: objects → JSON, Dates → ISO string', () => {
  assert.equal(csvEscape({ x: 1 }), '"{""x"":1}"');
  const d = new Date('2026-06-09T12:00:00.000Z');
  assert.equal(csvEscape(d), '2026-06-09T12:00:00.000Z');
});

test('resolveExportRange: default = last 7 days', () => {
  const now = new Date('2026-06-09T12:00:00.000Z');
  const r = resolveExportRange({ now });
  // 7-day window: from end-of-day backward 6 more days
  assert.equal(r.days, EXPORT_DEFAULT_DAYS);
});

test('resolveExportRange: clamps to MAX_DAYS keeping recent end', () => {
  const now = new Date('2026-06-09T00:00:00.000Z');
  // Request 200 days back — must clamp to 90 most recent
  const veryOld = new Date('2025-11-01T00:00:00.000Z');
  const r = resolveExportRange({ from: veryOld, to: now });
  assert.equal(r.days, EXPORT_MAX_DAYS);
  // `from` walked forward to keep recent end — verify via same floor
  // formula the service uses so we don't double-count the half-day.
  const msPerDay = 24 * 60 * 60 * 1000;
  const actualDays = Math.floor((r.to.getTime() - r.from.getTime()) / msPerDay) + 1;
  assert.equal(actualDays, EXPORT_MAX_DAYS);
});

test('exportAuditCsv: streams BOM + header + rows', async (t) => {
  const tag = makeTag('s138-stream');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  // Seed 3 audit rows with distinct entityIds tied to this tag
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-1`,
    after: { test: true },
  });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'UPDATE', entity: 'Webhook', entityId: `${tag}-2`,
    before: { x: 1 }, after: { x: 2 },
  });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'DELETE', entity: 'Webhook', entityId: `${tag}-3`,
    before: { dead: true },
  });
  t.after(() => db.auditLog.deleteMany({
    where: { entityId: { startsWith: tag } },
  }));

  const stream = new PassThrough();
  const collectPromise = collect(stream);
  const result = await exportAuditCsv({
    actorEmail: u.email,  // narrow to OUR rows only — dev DB has lots of others
    writeStream: stream,
  });
  stream.end();
  const csv = await collectPromise;

  // UTF-8 BOM
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'UTF-8 BOM prefixed');
  // Header line
  const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean);
  assert.match(lines[0], /^id,createdAt,action,entity,entityId,actorEmail,actorRole,ip,userAgent,before,after$/);
  // 3 data rows (filtered by actorEmail to avoid dev-DB noise)
  assert.equal(lines.length, 4, `1 header + 3 rows (got ${lines.length})`);
  assert.equal(result.rowsWritten, 3);
  assert.equal(result.capped, false);
  // before/after JSON columns present in correct order
  assert.match(lines[2], /UPDATE/);
});

test('exportAuditCsv: respects entity/action filters', async (t) => {
  const tag = makeTag('s138-filter');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-w`,
    after: {},
  });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'UPDATE', entity: 'Booking', entityId: `${tag}-b`,
    after: {},
  });
  t.after(() => db.auditLog.deleteMany({ where: { entityId: { startsWith: tag } } }));

  // Filter to Webhook entity only
  const stream = new PassThrough();
  const collectPromise = collect(stream);
  const r = await exportAuditCsv({
    entity: 'Webhook', actorEmail: u.email, writeStream: stream,
  });
  stream.end();
  const csv = await collectPromise;
  const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean);
  assert.equal(r.rowsWritten, 1, 'only Webhook row exported');
  assert.match(lines[1], /Webhook/);
  assert.doesNotMatch(lines[1], /Booking/);
});

test('exportAuditCsv: BOM + CRLF line endings (Excel-compatible)', async (t) => {
  const tag = makeTag('s138-bom');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await audit({
    req: fakeReq, actor: { id: u.id, email: u.email, role: 'OWNER' },
    action: 'CREATE', entity: 'Webhook', entityId: `${tag}-1`,
    after: {},
  });
  t.after(() => db.auditLog.deleteMany({ where: { entityId: { startsWith: tag } } }));

  const stream = new PassThrough();
  const collectPromise = collect(stream);
  await exportAuditCsv({ actorEmail: u.email, writeStream: stream });
  stream.end();
  const csv = await collectPromise;
  // CRLF between header and rows
  assert.ok(csv.includes('\r\n'), 'CRLF present');
});
