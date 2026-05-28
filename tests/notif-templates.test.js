// renderTemplate (5bb) — pure-unit for the file-based notif template engine.
//
// Invariants:
//   - {{key}} → vars[key]; missing keys render as empty string (defensive)
//   - Subject + body both substituted
//   - Missing template file throws loudly (fail-fast over silent empty body)
//   - Cache hits avoid re-reading; _clearTemplateCache resets for test edits
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderTemplate, _clearTemplateCache } from '../src/services/notifTemplates.js';

describe('renderTemplate — existing shipped templates', () => {
  before(() => _clearTemplateCache());

  test('BOOKING_CREATED__WA substitutes {{fullName}} + {{bookingNo}}', () => {
    const out = renderTemplate('BOOKING_CREATED', 'WA', {
      fullName: 'Ahmad', bookingNo: 'RP-2026-00099',
      paketTitle: 'Umroh Ramadhan', kelas: 'QUAD', paxCount: 2,
      totalAmountFormatted: '12.500.000',
    });
    assert.match(out.body, /Ahmad/);
    assert.match(out.body, /RP-2026-00099/);
  });

  test('CANCEL_REQUESTED__EMAIL substitutes admin-targeted vars', () => {
    const out = renderTemplate('CANCEL_REQUESTED', 'EMAIL', {
      bookingNo: 'RP-X', jemaahName: 'A', jemaahPhone: '+62',
      reason: 'pribadi', paketTitle: 'P', kelas: 'QUAD', paxCount: 1,
      paidAmountFormatted: '500.000', requestedByEmail: 'a@b', adminLink: '/admin/bookings/x',
    });
    assert.match(out.subject, /RP-X/);
    assert.match(out.body, /pribadi/);
    assert.match(out.body, /\/admin\/bookings\/x/);
  });

  test('PAYMENT_SETTLED_ADMIN__EMAIL substitutes amount + booking link', () => {
    const out = renderTemplate('PAYMENT_SETTLED_ADMIN', 'EMAIL', {
      bookingNo: 'RP-A', jemaahName: 'J', jemaahPhone: '+62',
      paketTitle: 'P', kelas: 'QUAD', paxCount: 1,
      amountFormatted: '1.000.000', method: 'TRANSFER',
      methodNote: '', orderId: 'PI-X',
      bookingStatus: 'LUNAS', lunasNote: '  ← LUNAS',
      adminLink: '/admin/bookings/a',
    });
    assert.match(out.subject, /Rp 1\.000\.000/);
    assert.match(out.body, /LUNAS/);
  });
});

describe('renderTemplate — substitution rules', () => {
  // Write a temp template + force it to load via the cache miss path
  const TYPE = 'GENERIC';
  const CHANNEL = 'CONSOLE';
  const tplDir = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'notifications', 'templates');
  const tplPath = path.join(tplDir, `${TYPE}__${CHANNEL}.json`);
  let preExisted = false;

  before(() => {
    preExisted = fs.existsSync(tplPath);
    if (!preExisted) {
      fs.writeFileSync(tplPath, JSON.stringify({
        subject: 'Hello {{name}}',
        body: 'Order {{orderId}} for {{name}}. Empty: [{{nope}}]',
      }));
    }
    _clearTemplateCache();
  });
  // Note: not deleting the temp file because GENERIC__CONSOLE is documented
  // as a catch-all and may be needed elsewhere. If it pre-existed we leave it.

  test('missing vars render as empty string (not "undefined")', () => {
    if (preExisted) return; // skip if we didn't author the template
    const out = renderTemplate(TYPE, CHANNEL, { name: 'World', orderId: '123' });
    assert.match(out.body, /\[\]/, 'missing {{nope}} → empty');
    assert.match(out.body, /for World/);
  });

  test('subject also substituted', () => {
    if (preExisted) return;
    const out = renderTemplate(TYPE, CHANNEL, { name: 'A' });
    assert.match(out.subject, /Hello A/);
  });
});

describe('renderTemplate — missing template throws loud', () => {
  test('unknown <TYPE>__<CHANNEL> throws with a hint', () => {
    assert.throws(
      () => renderTemplate('NOT_A_REAL_TYPE', 'WA', {}),
      /Notif template missing.*NOT_A_REAL_TYPE/,
    );
  });
});

describe('renderTemplate — cache', () => {
  test('repeated calls share the parsed JSON (fs.readFileSync hit once)', () => {
    _clearTemplateCache();
    let reads = 0;
    const orig = fs.readFileSync;
    fs.readFileSync = (...args) => { reads++; return orig.apply(fs, args); };
    try {
      renderTemplate('BOOKING_CREATED', 'WA', { fullName: 'a', bookingNo: 'b' });
      renderTemplate('BOOKING_CREATED', 'WA', { fullName: 'c', bookingNo: 'd' });
      renderTemplate('BOOKING_CREATED', 'WA', { fullName: 'e', bookingNo: 'f' });
    } finally {
      fs.readFileSync = orig;
    }
    assert.equal(reads, 1, '3 calls → 1 fs read (cached after first)');
  });
});
