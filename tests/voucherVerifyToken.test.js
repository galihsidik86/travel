// Stage 197 — voucher verification HMAC token.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVerifyUrl, verifyVoucherSig, VOUCHER_SIG_LEN,
} from '../src/lib/voucherVerifyToken.js';

test('exported VOUCHER_SIG_LEN is 16 hex chars', () => {
  assert.equal(VOUCHER_SIG_LEN, 16);
});

test('buildVerifyUrl: empty bookingId → empty string', () => {
  assert.equal(buildVerifyUrl(''), '');
  assert.equal(buildVerifyUrl(null), '');
});

test('buildVerifyUrl: shape /v/<id>?sig=<hex16>', () => {
  const url = buildVerifyUrl('abc123');
  assert.match(url, /\/v\/abc123\?sig=[0-9a-f]{16}$/);
});

test('verifyVoucherSig: matches signature from buildVerifyUrl', () => {
  const url = buildVerifyUrl('booking-xyz');
  const sig = url.match(/sig=([0-9a-f]+)/)[1];
  assert.equal(verifyVoucherSig('booking-xyz', sig), true);
});

test('verifyVoucherSig: wrong bookingId → false', () => {
  const url = buildVerifyUrl('booking-A');
  const sig = url.match(/sig=([0-9a-f]+)/)[1];
  assert.equal(verifyVoucherSig('booking-B', sig), false);
});

test('verifyVoucherSig: tampered signature → false', () => {
  const url = buildVerifyUrl('booking-X');
  const sig = url.match(/sig=([0-9a-f]+)/)[1];
  // Flip first char
  const bad = (sig[0] === 'f' ? '0' : 'f') + sig.slice(1);
  assert.equal(verifyVoucherSig('booking-X', bad), false);
});

test('verifyVoucherSig: wrong length signature → false', () => {
  assert.equal(verifyVoucherSig('x', 'short'), false);
  assert.equal(verifyVoucherSig('x', 'a'.repeat(32)), false);
});

test('verifyVoucherSig: empty / null inputs → false', () => {
  assert.equal(verifyVoucherSig('', 'a'.repeat(16)), false);
  assert.equal(verifyVoucherSig('id', ''), false);
  assert.equal(verifyVoucherSig(null, null), false);
});

test('buildVerifyUrl: same bookingId → same signature (deterministic)', () => {
  const u1 = buildVerifyUrl('same-id');
  const u2 = buildVerifyUrl('same-id');
  assert.equal(u1, u2, 'deterministic signing');
});

test('buildVerifyUrl: different bookingIds → different signatures', () => {
  const u1 = buildVerifyUrl('id-A');
  const u2 = buildVerifyUrl('id-B');
  const s1 = u1.match(/sig=([0-9a-f]+)/)[1];
  const s2 = u2.match(/sig=([0-9a-f]+)/)[1];
  assert.notEqual(s1, s2);
});
