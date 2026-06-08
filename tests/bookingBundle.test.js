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

  // Central directory entries reveal filenames in plaintext. We can grep
  // the buffer for the expected filenames without unzipping.
  const body = fake.body.toString('latin1');
  assert.ok(body.includes('MANIFEST.txt'), 'MANIFEST.txt entry present');
  assert.ok(body.includes('voucher.pdf'), 'voucher.pdf entry present');
  assert.ok(body.includes('calendar.ics'), 'calendar.ics entry present (paket has dates)');
});
