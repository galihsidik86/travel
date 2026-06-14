// Stage 289-291 — public inquiry submit + stale digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempUser, makeTag } from './_helpers.js';
import {
  submitPublicInquiry,
  listInquiries,
  normalisePhone,
} from '../src/services/publicInquiry.js';
import {
  getStaleInquiries,
  sendInquirySlaDigest,
} from '../src/services/inquirySlaDigest.js';

const fakeReq = { ip: '127.0.0.1', headers: { 'user-agent': 'smoke' }, get: () => 'test' };

// ── normalisePhone ─────────────────────────────────────────────

test('normalisePhone: strips non-digits + 0→62', () => {
  assert.equal(normalisePhone('0812-3456-7890'), '6281234567890');
  assert.equal(normalisePhone('+62 812 3456'), '628123456');
  assert.equal(normalisePhone('081234'), '6281234');
});

test('normalisePhone: empty input → empty', () => {
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone(null), '');
});

// ── submitPublicInquiry ────────────────────────────────────────

test('submitPublicInquiry: 400 on missing name', async () => {
  await assert.rejects(
    () => submitPublicInquiry({
      req: fakeReq, input: { phone: '08123456789' },
    }),
    (err) => err.code === 'INQUIRY_NAME_REQUIRED' && err.status === 400,
  );
});

test('submitPublicInquiry: 400 on short phone', async () => {
  await assert.rejects(
    () => submitPublicInquiry({
      req: fakeReq, input: { fullName: 'Test', phone: '081' },
    }),
    (err) => err.code === 'INQUIRY_PHONE_REQUIRED' && err.status === 400,
  );
});

test('submitPublicInquiry: persists with all fields', async () => {
  const r = await submitPublicInquiry({
    req: fakeReq, input: {
      fullName: 'Test Inquiry',
      phone: '08-1234-5678-90',
      email: 't@example.com',
      message: 'Tanya tentang paket',
      paketSlug: 'ramadhan-aqsa-2026',
      agentSlug: 'ahmad-w',
    },
  });
  assert.equal(r.idempotent, false);
  assert.ok(r.inquiry);
  assert.equal(r.inquiry.status, 'NEW');
  assert.equal(r.inquiry.fullName, 'Test Inquiry');
  assert.equal(r.inquiry.email, 't@example.com');
  assert.equal(r.inquiry.paketSlug, 'ramadhan-aqsa-2026');
  // Cleanup
  await db.publicInquiry.delete({ where: { id: r.inquiry.id } });
});

test('submitPublicInquiry: dedupes within 10-min window for same phone + paket', async () => {
  const phone = `0812-${Math.random().toString().slice(2, 10)}`;
  const r1 = await submitPublicInquiry({
    req: fakeReq, input: {
      fullName: 'Dedup Test', phone,
      paketSlug: 'ramadhan-aqsa-2026',
    },
  });
  const r2 = await submitPublicInquiry({
    req: fakeReq, input: {
      fullName: 'Dedup Test (resubmit)', phone,
      paketSlug: 'ramadhan-aqsa-2026',
    },
  });
  assert.equal(r2.idempotent, true);
  assert.equal(r2.inquiry.id, r1.inquiry.id, 'returns same row');
  await db.publicInquiry.delete({ where: { id: r1.inquiry.id } });
});

test('submitPublicInquiry: different paket → NOT deduped', async () => {
  const phone = `0813-${Math.random().toString().slice(2, 10)}`;
  const r1 = await submitPublicInquiry({
    req: fakeReq, input: {
      fullName: 'Cross-paket', phone, paketSlug: 'paket-a',
    },
  });
  const r2 = await submitPublicInquiry({
    req: fakeReq, input: {
      fullName: 'Cross-paket 2', phone, paketSlug: 'paket-b',
    },
  });
  assert.equal(r2.idempotent, false);
  assert.notEqual(r1.inquiry.id, r2.inquiry.id);
  await db.publicInquiry.deleteMany({ where: { id: { in: [r1.inquiry.id, r2.inquiry.id] } } });
});

// ── listInquiries ──────────────────────────────────────────────

test('listInquiries: shape + filters by status', async () => {
  const r = await listInquiries({ status: 'NEW' });
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.total, 'number');
  assert.equal(typeof r.page, 'number');
  assert.equal(typeof r.pageSize, 'number');
  // All returned rows must have status=NEW
  for (const row of r.rows) {
    assert.equal(row.status, 'NEW');
  }
});

// ── inquirySlaDigest ────────────────────────────────────────────

test('getStaleInquiries: surfaces NEW > staleHours; excludes fresh + terminal', async () => {
  // Create one stale NEW + one fresh + one CONVERTED
  const phone = `0814-${Math.random().toString().slice(2, 10)}`;
  const stale = await db.publicInquiry.create({
    data: {
      fullName: 'Stale Test', phone, status: 'NEW',
      createdAt: new Date(Date.now() - 48 * 3_600_000),
    },
  });
  const fresh = await db.publicInquiry.create({
    data: {
      fullName: 'Fresh Test', phone: `0815-${Math.random().toString().slice(2, 10)}`, status: 'NEW',
      createdAt: new Date(),
    },
  });
  const converted = await db.publicInquiry.create({
    data: {
      fullName: 'Converted Test', phone: `0816-${Math.random().toString().slice(2, 10)}`, status: 'CONVERTED',
      createdAt: new Date(Date.now() - 48 * 3_600_000),
    },
  });
  try {
    const rows = await getStaleInquiries({ staleHours: 24 });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(stale.id), 'stale NEW surfaces');
    assert.ok(!ids.includes(fresh.id), 'fresh NEW excluded');
    assert.ok(!ids.includes(converted.id), 'CONVERTED excluded');
  } finally {
    await db.publicInquiry.deleteMany({ where: { id: { in: [stale.id, fresh.id, converted.id] } } });
  }
});

test('sendInquirySlaDigest: enqueues admin EMAIL when stale exist', async (t) => {
  const owner = await tempUser(t, makeTag('isla-ow'), { role: 'OWNER' });
  // Inject one stale row so the digest has something to surface
  const stale = await db.publicInquiry.create({
    data: {
      fullName: 'SLA Test', phone: `0817-${Math.random().toString().slice(2, 10)}`,
      status: 'NEW',
      createdAt: new Date(Date.now() - 30 * 3_600_000),
    },
  });
  t.after(() => db.publicInquiry.deleteMany({ where: { id: stale.id } }));
  const before = await db.notification.count({
    where: { recipientEmail: owner.email, payload: { path: '$.kind', equals: 'inquiry_sla_digest' } },
  });
  const r = await sendInquirySlaDigest({});
  assert.ok(r.rowCount > 0);
  const after = await db.notification.count({
    where: { recipientEmail: owner.email, payload: { path: '$.kind', equals: 'inquiry_sla_digest' } },
  });
  assert.ok(after > before, 'notif enqueued to admin');
});

test('sendInquirySlaDigest: 20h cooldown skips repeat to same admin', async (t) => {
  const owner = await tempUser(t, makeTag('isla-cd'), { role: 'OWNER' });
  const stale = await db.publicInquiry.create({
    data: {
      fullName: 'CD Test', phone: `0818-${Math.random().toString().slice(2, 10)}`,
      status: 'NEW',
      createdAt: new Date(Date.now() - 30 * 3_600_000),
    },
  });
  t.after(() => db.publicInquiry.deleteMany({ where: { id: stale.id } }));
  await sendInquirySlaDigest({});
  const after1 = await db.notification.count({
    where: { recipientEmail: owner.email, payload: { path: '$.kind', equals: 'inquiry_sla_digest' } },
  });
  await sendInquirySlaDigest({});
  const after2 = await db.notification.count({
    where: { recipientEmail: owner.email, payload: { path: '$.kind', equals: 'inquiry_sla_digest' } },
  });
  assert.equal(after1, after2, 'cooldown blocked second enqueue');
});
