// Stage 105 — booking bundle ZIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { streamBookingBundle } from '../src/services/bookingBundle.js';
import { getAdminBookingVoucher } from '../src/services/bookingVoucher.js';

class FakeResponse extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  _write(chunk, _enc, cb) { this.chunks.push(chunk); cb(); }
  destroy() {}
  get body() { return Buffer.concat(this.chunks); }
}

function awaitFinish(res) {
  return new Promise((resolve) => res.on('finish', resolve));
}

test('streamBookingBundle: produces a valid ZIP', async (t) => {
  const tag = makeTag('zip-1');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  await streamBookingBundle(voucher, fake);
  await done;

  // ZIP file signature: PK\x03\x04
  const head = fake.body.subarray(0, 4);
  assert.equal(head[0], 0x50, 'P');
  assert.equal(head[1], 0x4b, 'K');
  assert.equal(head[2], 0x03);
  assert.equal(head[3], 0x04);

  // Headers
  assert.equal(fake.headers['content-type'], 'application/zip');
  assert.ok(fake.headers['content-disposition'].endsWith('.zip"'));
  assert.ok(fake.headers['content-disposition'].includes(booking.bookingNo));
});

test('streamBookingBundle: filename sanitised (path-traversal safe)', async (t) => {
  const tag = makeTag('zip-fn');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  await db.booking.update({ where: { id: booking.id }, data: { bookingNo: 'RP-../../etc/passwd' } });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  await streamBookingBundle(voucher, fake);
  await done;

  const disp = fake.headers['content-disposition'];
  assert.ok(!disp.includes('../'), 'path traversal stripped');
  assert.ok(!disp.includes('/etc/'));
});

test('streamBookingBundle: contains MANIFEST.txt + voucher.pdf entries', async (t) => {
  const tag = makeTag('zip-entries');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag, { dayCount: 2 });
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  await streamBookingBundle(voucher, fake);
  await done;

  const body = fake.body.toString('latin1');
  assert.ok(body.includes('MANIFEST.txt'), 'MANIFEST.txt entry present');
  assert.ok(body.includes('voucher.pdf'), 'voucher.pdf entry present');
  assert.ok(body.includes('calendar.ics'), 'calendar.ics entry present (paket has dates)');
});

test('streamBulkBookingBundle: empty vouchers → 400 + plain text', async (t) => {
  const { streamBulkBookingBundle } = await import('../src/services/bookingBundle.js');
  const fake = new FakeResponse();
  let status = 200, body = '';
  fake.status = (s) => { status = s; return fake; };
  fake.type = () => fake;
  fake.send = (s) => { body = s; fake.end(); };
  const done = awaitFinish(fake);
  await streamBulkBookingBundle({ vouchers: [], paketTitle: 'X' }, fake);
  await done;
  assert.equal(status, 400);
  assert.ok(body.includes('Tidak ada'));
});

test('streamBulkBookingBundle: packages each booking under its own folder', async (t) => {
  const tag = makeTag('bulk');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b1 = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  const v1 = await getAdminBookingVoucher(b1.id);
  const v2 = await getAdminBookingVoucher(b2.id);

  const { streamBulkBookingBundle } = await import('../src/services/bookingBundle.js');
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  await streamBulkBookingBundle({ vouchers: [v1, v2], paketTitle: paket.title }, fake);
  await done;

  // ZIP signature
  assert.equal(fake.body[0], 0x50);
  assert.equal(fake.body[1], 0x4b);

  const body = fake.body.toString('latin1');
  // Folder per bookingNo
  assert.ok(body.includes(`bookings/${b1.bookingNo}/voucher.pdf`));
  assert.ok(body.includes(`bookings/${b2.bookingNo}/voucher.pdf`));
  assert.ok(body.includes('BUNDLES_MANIFEST.txt'));

  // Filename includes the count
  assert.ok(fake.headers['content-disposition'].includes('_2'));
});

test('streamBookingBundle: csv format swaps PDF for CSV trio', async (t) => {
  const tag = makeTag('zip-csv');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  await streamBookingBundle(voucher, fake, { format: 'csv' });
  await done;

  const body = fake.body.toString('latin1');
  assert.ok(body.includes('booking.csv'), 'booking.csv present');
  assert.ok(body.includes('payments.csv'), 'payments.csv present');
  assert.ok(body.includes('docs.csv'), 'docs.csv present');
  assert.ok(!body.includes('voucher.pdf'), 'voucher.pdf NOT included in csv mode');
  assert.ok(!body.includes('calendar.ics'), 'calendar.ics NOT included in csv mode');
  assert.ok(fake.headers['content-disposition'].includes('_csv.zip'),
    'filename carries _csv suffix');
});
