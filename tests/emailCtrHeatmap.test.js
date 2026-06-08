import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import { getEmailClickHeatmap } from '../src/services/emailCtr.js';

async function makeEmailWithClicks({ tag, type, targetUrls }) {
  const notif = await db.notification.create({
    data: {
      type, channel: 'EMAIL', status: 'SENT',
      recipientEmail: `${tag}@example.test`,
      body: 'b', sentAt: new Date(),
    },
  });
  for (const { url, count = 1 } of targetUrls) {
    await db.emailClick.create({
      data: {
        notificationId: notif.id,
        targetUrl: url,
        clickCount: count,
      },
    });
  }
  return notif;
}

test('getEmailClickHeatmap: returns empty for unknown type', async () => {
  const r = await getEmailClickHeatmap({ type: 'NONEXISTENT_TYPE_xyzzy', days: 30 });
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.clicks, 0);
});

test('getEmailClickHeatmap: returns null type when type omitted', async () => {
  const r = await getEmailClickHeatmap({ days: 30 });
  assert.equal(r.type, null);
  assert.deepEqual(r.rows, []);
});

test('getEmailClickHeatmap: aggregates clicks per normalised URL', async (t) => {
  const tag = makeTag('hm-agg');
  // Three notifs of the same type, each with one click on /admin
  // and one click each on different deep links.
  const created = [];
  for (let i = 0; i < 3; i += 1) {
    const n = await makeEmailWithClicks({
      tag: `${tag}-${i}`,
      type: 'WAITLIST_SLOT_FREED',
      targetUrls: [
        { url: 'http://localhost:3001/admin', count: 1 },
        { url: `http://localhost:3001/admin/paket/p-${i}/waitlist`, count: 1 },
      ],
    });
    created.push(n.id);
  }
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: { in: created } } });
    await db.notification.deleteMany({ where: { id: { in: created } } });
  });

  const r = await getEmailClickHeatmap({ type: 'WAITLIST_SLOT_FREED', days: 30 });
  const adminRow = r.rows.find((x) => x.url === '/admin');
  assert.ok(adminRow, '/admin row should exist after normalisation');
  assert.equal(adminRow.clicks, 3, 'three clicks aggregated into one row');
  assert.equal(adminRow.recipients, 3, 'three distinct recipients');

  // Deep links are distinct → 3 separate rows of clicks=1 each
  const deepRows = r.rows.filter((x) => x.url.startsWith('/admin/paket'));
  assert.equal(deepRows.length, 3);
  for (const dr of deepRows) {
    assert.equal(dr.clicks, 1);
  }
});

test('getEmailClickHeatmap: scheme/host stripped but path/query preserved', async (t) => {
  const tag = makeTag('hm-norm');
  const n = await makeEmailWithClicks({
    tag, type: 'WEEKLY_DIGEST_OWNER',
    targetUrls: [
      { url: 'https://prod.religio.pro/admin?tab=ops' },
      { url: 'http://localhost:3001/admin?tab=ops' },
    ],
  });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: n.id } });
    await db.notification.delete({ where: { id: n.id } });
  });

  const r = await getEmailClickHeatmap({ type: 'WEEKLY_DIGEST_OWNER', days: 30 });
  const match = r.rows.find((x) => x.url === '/admin?tab=ops');
  assert.ok(match, 'prod + localhost collapse to same normalised path+query');
  assert.equal(match.clicks, 2);
});

test('getEmailClickHeatmap: sharePct sums to ~100', async (t) => {
  const tag = makeTag('hm-share');
  const n = await makeEmailWithClicks({
    tag, type: 'DAILY_DIGEST_OWNER',
    targetUrls: [
      { url: 'http://x/admin', count: 4 },
      { url: 'http://x/admin/payouts', count: 6 },
    ],
  });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: n.id } });
    await db.notification.delete({ where: { id: n.id } });
  });

  const r = await getEmailClickHeatmap({ type: 'DAILY_DIGEST_OWNER', days: 30 });
  const total = r.rows.reduce((s, x) => s + (x.sharePct || 0), 0);
  // 1dp rounding can leave us a tenth off — allow ±0.5
  assert.ok(Math.abs(total - 100) <= 0.5, `share sum=${total}`);
  // Sorted by clicks desc
  assert.ok(r.rows[0].clicks >= r.rows[1].clicks, 'sorted by clicks desc');
});

test('getEmailClickHeatmap: respects days window', async (t) => {
  const tag = makeTag('hm-win');
  // Old notif — sentAt 60 days ago
  const old = await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
      recipientEmail: `${tag}@example.test`, body: 'b',
      sentAt: new Date(Date.now() - 60 * 86_400_000),
    },
  });
  await db.emailClick.create({
    data: { notificationId: old.id, targetUrl: 'http://x/admin' },
  });
  t.after(async () => {
    await db.emailClick.deleteMany({ where: { notificationId: old.id } });
    await db.notification.delete({ where: { id: old.id } });
  });

  // 30-day window — old notif EXCLUDED
  const r30 = await getEmailClickHeatmap({ type: 'GENERIC', days: 30 });
  const inWindow = r30.rows.some((x) => x.url === '/admin');
  assert.equal(inWindow, false, '60d-old click must NOT appear in 30d window');

  // 90-day window — old notif INCLUDED
  const r90 = await getEmailClickHeatmap({ type: 'GENERIC', days: 90 });
  const found = r90.rows.some((x) => x.url === '/admin');
  assert.equal(found, true, 'same click appears in 90d window');
});
