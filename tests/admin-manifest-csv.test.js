// 5gg admin manifest CSV export — money cols + CANCELLED-with-money,
// distinct from crew variant (already tested in tests/crew.test.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { exportManifestCsv } from '../src/services/adminDashboard.js';
import { recordPayment } from '../src/services/payment.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; continue; }
      if (ch === '"') { inQ = true; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

describe('exportManifestCsv (5gg)', () => {
  test('returns null for unknown paket', async () => {
    assert.equal(await exportManifestCsv('does-not-exist'), null);
  });

  test('header includes money cols; BOM; CANCELLED row keeps money values', async (t) => {
    const tag = makeTag('5gg-export');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);

    // Active booking with payment
    const bkActive = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await recordPayment({ ...ctx, bookingId: bkActive.id, amount: 300_000, method: 'TRANSFER' });

    // Edge-case jemaah name with comma + quote — RFC 4180 escape paths
    const jemEdge = await db.jemaahProfile.create({
      data: { fullName: 'Ahmad, "Edge"', phone: '+628333' },
    });
    t.after(() => db.jemaahProfile.deleteMany({ where: { id: jemEdge.id } }));
    const bkEdge = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-E`, paketId: paket.id, jemaahId: jemEdge.id,
        kelas: 'TRIPLE', paxCount: 2,
        totalAmount: '2000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await recordPayment({ ...ctx, bookingId: bkEdge.id, amount: 2_000_000, method: 'TRANSFER' });
    // Cancel the edge booking AFTER payment — money cols should still show
    // the historical amounts (refund is a separate flow, not reflected here)
    await cancelBooking({ ...ctx, bookingId: bkEdge.id, reason: 'test cancel' });

    const out = await exportManifestCsv(paket.slug);
    assert.ok(out.csv);
    assert.equal(out.csv.charCodeAt(0), 0xFEFF, 'BOM');

    const lines = out.csv.split('\r\n');
    const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ''));

    // Money cols present (vs crew variant which strips them)
    assert.ok(header.includes('Total (IDR)'));
    assert.ok(header.includes('Dibayar (IDR)'));
    assert.ok(header.includes('Sisa (IDR)'));

    // CANCELLED booking still appears (admin sees full lifetime, not just active)
    assert.equal(lines.length, 3, 'header + 2 bookings (incl. CANCELLED)');

    const rowA = lines.slice(1).map(parseCsvLine).find((r) => r[0] === bkActive.bookingNo);
    const rowE = lines.slice(1).map(parseCsvLine).find((r) => r[0] === bkEdge.bookingNo);
    assert.ok(rowA, 'active booking row present');
    assert.ok(rowE, 'cancelled booking row present (admin export keeps history)');

    // Money col positions: header idx for Total/Dibayar/Sisa
    const totalIdx = header.indexOf('Total (IDR)');
    const paidIdx = header.indexOf('Dibayar (IDR)');
    const sisaIdx = header.indexOf('Sisa (IDR)');
    assert.equal(rowA[totalIdx], '1000000');
    assert.equal(rowA[paidIdx], '300000');
    assert.equal(rowA[sisaIdx], '700000', '1M - 300k = 700k');
    assert.equal(rowE[totalIdx], '2000000');
    assert.equal(rowE[paidIdx], '2000000');
    assert.equal(rowE[sisaIdx], '0', 'fully-paid cancelled booking');

    // Edge-case name round-trips through escape
    const nameIdx = header.indexOf('Nama Jemaah');
    assert.equal(rowE[nameIdx], 'Ahmad, "Edge"', 'comma + quote preserved');

    // Cancel cols populated for cancelled row
    assert.match(rowE[header.indexOf('Cancelled At')], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rowE[header.indexOf('Cancel Reason')], 'test cancel');

    // Filename: manifest_<slug>_<today>.csv
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(out.filename, `manifest_${paket.slug}_${today}.csv`);
  });
});
