// Stage 101 — voucher PDF rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { streamVoucherPdf } from '../src/services/bookingVoucherPdf.js';
import { getAdminBookingVoucher } from '../src/services/bookingVoucher.js';

class FakeResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
  }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  _write(chunk, _enc, cb) { this.chunks.push(chunk); cb(); }
  get body() { return Buffer.concat(this.chunks); }
}

function awaitFinish(res) {
  return new Promise((resolve) => res.on('finish', resolve));
}

test('streamVoucherPdf: writes a valid PDF', async (t) => {
  const tag = makeTag('pdf-1');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag, { dayCount: 5 });
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  streamVoucherPdf(voucher, fake);
  await done;

  // PDF signature
  const head = fake.body.subarray(0, 4).toString('ascii');
  assert.equal(head, '%PDF', 'output starts with PDF magic bytes');
  // EOF marker
  const tail = fake.body.subarray(-6).toString('ascii');
  assert.ok(tail.includes('%%EOF'), 'output ends with %%EOF');

  // Headers set
  assert.equal(fake.headers['content-type'], 'application/pdf');
  assert.ok(fake.headers['content-disposition'].includes(booking.bookingNo));
  assert.ok(fake.headers['content-disposition'].startsWith('attachment;'));
});

test('streamVoucherPdf: sanitises filename (no path traversal)', async (t) => {
  const tag = makeTag('pdf-fn');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  // Hack the bookingNo to something nasty (simulates a data corruption case)
  await db.booking.update({ where: { id: booking.id }, data: { bookingNo: 'RP-../etc/passwd' } });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  streamVoucherPdf(voucher, fake);
  await done;

  const disp = fake.headers['content-disposition'];
  assert.ok(!disp.includes('../'), 'path traversal stripped from filename');
  assert.ok(!disp.includes('/'), 'no path separators in filename');
});

test('streamVoucherPdf: handles paket without optional fields', async (t) => {
  const tag = makeTag('pdf-min');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag); // no airline/route/days
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const voucher = await getAdminBookingVoucher(booking.id);
  const fake = new FakeResponse();
  const done = awaitFinish(fake);
  streamVoucherPdf(voucher, fake);
  await done;

  // Should not throw + still produce a valid PDF
  assert.equal(fake.body.subarray(0, 4).toString('ascii'), '%PDF');
});
