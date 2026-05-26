// Pure-function unit tests — no DB, no network. Bundles helpers across modules
// so the cheap stuff runs first and fast.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sanitiseBasename, isInlineImageMime } from '../src/lib/docStorage.js';
import { normaliseIdPhone } from '../src/lib/senders/fonnte.js';
import {
  verifyMidtransSignature, mapMidtransStatus, mapMidtransMethod,
} from '../src/lib/midtrans.js';
import { transitionStatus } from '../src/services/payment.js';
import crypto from 'node:crypto';

describe('docStorage.sanitiseBasename', () => {
  test('strips path traversal', () => {
    assert.equal(sanitiseBasename('../../etc/passwd'), 'passwd');
  });
  test('collapses spaces + drops extension', () => {
    assert.equal(sanitiseBasename('My Paspor 2026!.PDF'), 'My_Paspor_2026');
  });
  test('empty/falsy → "file" fallback', () => {
    assert.equal(sanitiseBasename(''), 'file');
    assert.equal(sanitiseBasename(null), 'file');
    assert.equal(sanitiseBasename(undefined), 'file');
  });
  test('strips diacritics', () => {
    assert.equal(sanitiseBasename('café-résumé'), 'cafe-resume');
  });
});

describe('docStorage.isInlineImageMime', () => {
  test('jpeg/png/webp are renderable in <img>', () => {
    assert.equal(isInlineImageMime('image/jpeg'), true);
    assert.equal(isInlineImageMime('image/png'), true);
    assert.equal(isInlineImageMime('image/webp'), true);
  });
  test('heic/heif rejected (Chrome/Firefox lack decoder)', () => {
    assert.equal(isInlineImageMime('image/heic'), false);
    assert.equal(isInlineImageMime('image/heif'), false);
  });
  test('pdf + falsy rejected', () => {
    assert.equal(isInlineImageMime('application/pdf'), false);
    assert.equal(isInlineImageMime(''), false);
    assert.equal(isInlineImageMime(null), false);
  });
});

describe('fonnte.normaliseIdPhone', () => {
  test('local 08… → 62…', () => {
    assert.equal(normaliseIdPhone('081234567890'), '6281234567890');
  });
  test('+62 with spacing → digits', () => {
    assert.equal(normaliseIdPhone('+62 812-3456-7890'), '6281234567890');
  });
  test('already 62… passes through', () => {
    assert.equal(normaliseIdPhone('6281234567890'), '6281234567890');
  });
  test('empty / no digits → null', () => {
    assert.equal(normaliseIdPhone(''), null);
    assert.equal(normaliseIdPhone(null), null);
    assert.equal(normaliseIdPhone('not a phone'), null);
  });
});

describe('midtrans.verifyMidtransSignature', () => {
  // In fake mode (no MIDTRANS_SERVER_KEY env), the signature is just
  // SHA512(order_id + status_code + gross_amount) — server_key = ''.
  function makePayload(order_id, status_code, gross_amount, serverKey = '') {
    const sig = crypto.createHash('sha512')
      .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
      .digest('hex');
    return { order_id, status_code, gross_amount, signature_key: sig };
  }
  test('accepts valid signature', () => {
    const p = makePayload('PI-abc', '200', '100000.00');
    assert.equal(verifyMidtransSignature(p), true);
  });
  test('rejects tampered signature', () => {
    const p = makePayload('PI-abc', '200', '100000.00');
    p.signature_key = 'a'.repeat(128);
    assert.equal(verifyMidtransSignature(p), false);
  });
  test('rejects mismatched payload fields', () => {
    const p = makePayload('PI-abc', '200', '100000.00');
    p.gross_amount = '999999.00'; // tampered, sig was for 100000
    assert.equal(verifyMidtransSignature(p), false);
  });
  test('rejects missing fields', () => {
    assert.equal(verifyMidtransSignature({}), false);
    assert.equal(verifyMidtransSignature(null), false);
  });
  test('rejects wrong-length signature without throwing', () => {
    const p = makePayload('PI-abc', '200', '100000.00');
    p.signature_key = 'short';
    assert.equal(verifyMidtransSignature(p), false);
  });
});

describe('midtrans.mapMidtransStatus', () => {
  test('settlement → SETTLED', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'settlement' }), 'SETTLED');
  });
  test('capture + fraud accept → SETTLED', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'capture', fraud_status: 'accept' }), 'SETTLED');
  });
  test('capture + fraud deny → FAILED', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'capture', fraud_status: 'deny' }), 'FAILED');
  });
  test('capture + fraud challenge → PENDING', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'capture', fraud_status: 'challenge' }), 'PENDING');
  });
  test('pending → PENDING', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'pending' }), 'PENDING');
  });
  test('deny / failure → FAILED', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'deny' }), 'FAILED');
    assert.equal(mapMidtransStatus({ transaction_status: 'failure' }), 'FAILED');
  });
  test('cancel → CANCELLED, expire → EXPIRED', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'cancel' }), 'CANCELLED');
    assert.equal(mapMidtransStatus({ transaction_status: 'expire' }), 'EXPIRED');
  });
  test('unknown → PENDING (defensive default)', () => {
    assert.equal(mapMidtransStatus({ transaction_status: 'who-knows' }), 'PENDING');
  });
});

describe('midtrans.mapMidtransMethod', () => {
  test('credit_card → CARD', () => assert.equal(mapMidtransMethod('credit_card'), 'CARD'));
  test('bank_transfer + echannel → VA', () => {
    assert.equal(mapMidtransMethod('bank_transfer'), 'VA');
    assert.equal(mapMidtransMethod('echannel'), 'VA');
  });
  test('qris → QRIS', () => assert.equal(mapMidtransMethod('qris'), 'QRIS'));
  test('e-wallets → EWALLET', () => {
    for (const p of ['gopay', 'shopeepay', 'dana', 'linkaja']) {
      assert.equal(mapMidtransMethod(p), 'EWALLET', `${p} → EWALLET`);
    }
  });
  test('unrecognised → TRANSFER (fallback)', () => {
    assert.equal(mapMidtransMethod('alien-pay'), 'TRANSFER');
    assert.equal(mapMidtransMethod(undefined), 'TRANSFER');
  });
});

describe('payment.transitionStatus (state machine, forward-only)', () => {
  test('paid 0 → keep status', () => {
    assert.equal(transitionStatus('PENDING', 0, 1000), 'PENDING');
    assert.equal(transitionStatus('BOOKED', 0, 1000), 'BOOKED');
  });
  test('paid >= total → LUNAS', () => {
    assert.equal(transitionStatus('PENDING', 1000, 1000), 'LUNAS');
    assert.equal(transitionStatus('DP_PAID', 1500, 1000), 'LUNAS');
  });
  test('PENDING/BOOKED + partial → DP_PAID', () => {
    assert.equal(transitionStatus('PENDING', 300, 1000), 'DP_PAID');
    assert.equal(transitionStatus('BOOKED', 300, 1000), 'DP_PAID');
  });
  test('DP_PAID + more partial → PARTIAL', () => {
    assert.equal(transitionStatus('DP_PAID', 500, 1000), 'PARTIAL');
  });
  test('terminal statuses unchanged', () => {
    assert.equal(transitionStatus('LUNAS', 500, 1000), 'LUNAS');
    assert.equal(transitionStatus('CANCELLED', 500, 1000), 'CANCELLED');
    assert.equal(transitionStatus('PARTIAL', 500, 1000), 'PARTIAL');
  });
});
