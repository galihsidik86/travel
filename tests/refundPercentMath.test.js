// Stage 183 — refund preset percentage buttons. Pure UI feature, but we
// pin the percentage math here so any future logic copying it (e.g.
// server-side preset API) stays consistent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror the inline JS math: Math.floor(paid * (pct / 100))
function computeRefundFromPreset(paid, pct) {
  return Math.floor(paid * (pct / 100));
}

test('25% of round amounts yields exact quarter', () => {
  assert.equal(computeRefundFromPreset(1_000_000, 25), 250_000);
  assert.equal(computeRefundFromPreset(4_000_000, 25), 1_000_000);
});

test('50% halves the paid amount', () => {
  assert.equal(computeRefundFromPreset(1_000_000, 50), 500_000);
  assert.equal(computeRefundFromPreset(2_500_000, 50), 1_250_000);
});

test('100% equals balance', () => {
  assert.equal(computeRefundFromPreset(1_000_000, 100), 1_000_000);
  assert.equal(computeRefundFromPreset(5_170_000, 100), 5_170_000);
});

test('non-divisible amounts floor — avoids fractional Rupiah', () => {
  // 33% of 100 = 33.33 → floor to 33
  assert.equal(computeRefundFromPreset(100, 33), 33);
  // 75% of 99 = 74.25 → floor to 74
  assert.equal(computeRefundFromPreset(99, 75), 74);
});

test('paid=0 → 0 regardless of pct', () => {
  assert.equal(computeRefundFromPreset(0, 25), 0);
  assert.equal(computeRefundFromPreset(0, 100), 0);
});
