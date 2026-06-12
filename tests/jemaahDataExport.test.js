// Stage 239 — jemaah self-service data export ZIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Writable } from 'node:stream';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import {
  buildJemaahDataExportPayload,
  streamJemaahDataExport,
} from '../src/services/jemaahDataExport.js';

function collectStream() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  w.bufferPromise = new Promise((resolve, reject) => {
    w.on('finish', () => resolve(Buffer.concat(chunks)));
    w.on('error', reject);
  });
  return w;
}

test('buildJemaahDataExportPayload: returns null for unknown userId', async () => {
  const r = await buildJemaahDataExportPayload({ userId: 'no-such' });
  assert.equal(r, null);
});

test('buildJemaahDataExportPayload: includes user + jemaah profile', async (t) => {
  const tag = makeTag('s239-payload');
  const u = await tempJemaah(t, tag);

  const r = await buildJemaahDataExportPayload({ userId: u.id });
  assert.ok(r);
  assert.equal(r.user.id, u.id);
  assert.equal(r.user.email, u.email);
  assert.ok(r.user.jemaah);
});

test('buildJemaahDataExportPayload: includes own bookings + payments', async (t) => {
  const tag = makeTag('s239-bookings');
  const u = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id, jemaahUserId: u.id });
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '500000', currency: 'IDR',
      method: 'CASH', status: 'PAID',
      paidAt: new Date(),
    },
  });
  t.after(async () => { await db.payment.deleteMany({ where: { bookingId: b.id } }); });

  const r = await buildJemaahDataExportPayload({ userId: u.id });
  assert.equal(r.bookings.length, 1);
  assert.equal(r.bookings[0].id, b.id);
  assert.equal(r.payments.length, 1);
});

test('buildJemaahDataExportPayload: does NOT include other jemaah\'s bookings', async (t) => {
  const tag = makeTag('s239-isolated');
  const me = await tempJemaah(t, tag + '-me');
  const other = await tempJemaah(t, tag + '-other');
  const paket = await tempPaket(t, tag);
  // Other jemaah's booking on the same paket
  await tempBooking({ paket, jemaahProfileId: other.jemaah.id, jemaahUserId: other.id });

  const r = await buildJemaahDataExportPayload({ userId: me.id });
  assert.equal(r.bookings.length, 0, "must not leak other jemaah's bookings");
});

test('buildJemaahDataExportPayload: scopes notifications to recipientUserId', async (t) => {
  const tag = makeTag('s239-notifs');
  const u = await tempJemaah(t, tag);
  await db.notification.create({
    data: {
      type: 'GENERIC', channel: 'EMAIL', status: 'SENT',
      recipientUserId: u.id,
      subject: 'mine', body: 'hello',
      sentAt: new Date(),
    },
  });
  t.after(async () => { await db.notification.deleteMany({ where: { recipientUserId: u.id } }); });

  const r = await buildJemaahDataExportPayload({ userId: u.id });
  assert.ok(r.notifications.find((n) => n.subject === 'mine'));
});

test('streamJemaahDataExport: ZIP bytes start with PK signature', async (t) => {
  const tag = makeTag('s239-zip');
  const u = await tempJemaah(t, tag);
  const payload = await buildJemaahDataExportPayload({ userId: u.id });

  const sink = collectStream();
  await streamJemaahDataExport(payload, sink);
  sink.end();
  const buf = await sink.bufferPromise;

  // ZIP files start with "PK" (0x50 0x4b)
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  // Reasonable size — should contain at least the CSVs + manifest
  assert.ok(buf.length > 200);
});

test('streamJemaahDataExport: contains profile.csv + bookings.csv + MANIFEST', async (t) => {
  const tag = makeTag('s239-contents');
  const u = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id, jemaahUserId: u.id });
  const payload = await buildJemaahDataExportPayload({ userId: u.id });

  const sink = collectStream();
  await streamJemaahDataExport(payload, sink);
  sink.end();
  const buf = await sink.bufferPromise;
  // Filenames appear in the central directory at the end (uncompressed names)
  const tail = buf.toString('latin1');
  assert.match(tail, /profile\.csv/);
  assert.match(tail, /bookings\.csv/);
  assert.match(tail, /MANIFEST\.txt/);
});
