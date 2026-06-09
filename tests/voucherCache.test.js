// Stage 149 — voucher PDF cache. Renders are content-addressed by a
// hash of every displayed field; cache invalidates when any field
// changes. Cache lives under private/voucher-cache/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  hashVoucher, getOrRenderVoucherPdf, CACHE_DIR,
} from '../src/services/voucherCache.js';

// Synthesise a minimal voucher object — same shape produced by
// getAdminBookingVoucher.
function makeVoucher(overrides = {}) {
  return {
    id: 'bk-test-001',
    bookingNo: 'RP-TEST-00001',
    status: 'DP_PAID',
    kelas: 'QUAD',
    paxCount: 1,
    totalAmount: 5_000_000,
    paidAmount: 2_500_000,
    generatedAt: new Date('2026-06-09T10:00:00Z'),
    totals: { totalAmount: 5_000_000, paidAmount: 2_500_000, remaining: 2_500_000, paidPct: 50 },
    paket: {
      slug: 'demo-paket', title: 'Demo Paket',
      departureDate: new Date('2026-08-01'),
      returnDate: new Date('2026-08-12'),
      airline: 'GA', routeFrom: 'CGK', routeTo: 'JED',
      days: [{ dayNumber: 1, title: 'Arrival' }],
    },
    jemaah: {
      fullName: 'Test Jemaah',
      phone: '+62811',
      email: 'jemaah@example.test',
      passportNo: 'X1234567',
    },
    agent: { slug: 'agen-demo', displayName: 'Agen Demo', whatsapp: '+62812' },
    payments: [
      { id: 'p1', amount: '2500000', method: 'TRANSFER', status: 'PAID',
        createdAt: new Date('2026-06-01T10:00:00Z') },
    ],
    room: null,
    ...overrides,
  };
}

test('hashVoucher: deterministic for the same input', () => {
  const v = makeVoucher();
  const h1 = hashVoucher(v);
  const h2 = hashVoucher(makeVoucher());  // same field values
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test('hashVoucher: changes when paidAmount changes', () => {
  const a = hashVoucher(makeVoucher({ paidAmount: 2_500_000 }));
  const b = hashVoucher(makeVoucher({ paidAmount: 3_000_000 }));
  assert.notEqual(a, b);
});

test('hashVoucher: changes when jemaah identity changes', () => {
  const a = hashVoucher(makeVoucher());
  const b = hashVoucher(makeVoucher({
    jemaah: { ...makeVoucher().jemaah, fullName: 'Different Name' },
  }));
  assert.notEqual(a, b);
});

test('hashVoucher: stable across payments shape variations', () => {
  // payments[].amount may come in as Decimal-string OR Decimal object
  const a = hashVoucher(makeVoucher());
  const b = hashVoucher(makeVoucher({
    payments: [
      { id: 'p1', amount: { toString: () => '2500000' }, method: 'TRANSFER',
        status: 'PAID', createdAt: new Date('2026-06-01T10:00:00Z') },
    ],
  }));
  assert.equal(a, b, 'Decimal vs string serialise identically');
});

test('getOrRenderVoucherPdf: MISS on first call, HIT on second', async (t) => {
  const v = makeVoucher();
  // Use a unique bookingId so we don't collide with leftover caches
  const bookingId = `cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cleanup = () => {
    // Best-effort cleanup of any files this test created
    try {
      const dir = joinPath(process.cwd(), CACHE_DIR);
      const files = readdirSync(dir).filter((f) => f.startsWith(bookingId + '__'));
      for (const f of files) try { rmSync(joinPath(dir, f)); } catch {}
    } catch {}
  };
  t.after(cleanup);

  const r1 = await getOrRenderVoucherPdf({ bookingId, voucher: { ...v, id: bookingId } });
  assert.equal(r1.cached, false, 'first call → MISS');
  assert.ok(r1.buffer.length > 0);
  // PDF magic header bytes %PDF
  assert.equal(r1.buffer.slice(0, 4).toString(), '%PDF');
  assert.ok(existsSync(r1.filePath), 'cache file written');

  const r2 = await getOrRenderVoucherPdf({ bookingId, voucher: { ...v, id: bookingId } });
  assert.equal(r2.cached, true, 'second call → HIT');
  assert.equal(r2.buffer.length, r1.buffer.length);
});

test('getOrRenderVoucherPdf: content change → new hash → fresh render → old cleaned', async (t) => {
  const bookingId = `cache-invalidate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cleanup = () => {
    try {
      const dir = joinPath(process.cwd(), CACHE_DIR);
      const files = readdirSync(dir).filter((f) => f.startsWith(bookingId + '__'));
      for (const f of files) try { rmSync(joinPath(dir, f)); } catch {}
    } catch {}
  };
  t.after(cleanup);

  const v1 = { ...makeVoucher(), id: bookingId, paidAmount: 2_500_000 };
  const v2 = { ...makeVoucher(), id: bookingId, paidAmount: 3_000_000 };

  const r1 = await getOrRenderVoucherPdf({ bookingId, voucher: v1 });
  assert.equal(r1.cached, false);
  const oldHash = r1.hash;

  const r2 = await getOrRenderVoucherPdf({ bookingId, voucher: v2 });
  assert.equal(r2.cached, false, 'different hash → MISS');
  assert.notEqual(r2.hash, oldHash);

  // Old hash file cleaned up
  const dir = joinPath(process.cwd(), CACHE_DIR);
  const files = readdirSync(dir).filter((f) => f.startsWith(bookingId + '__'));
  assert.equal(files.length, 1, 'only the current-hash file remains');
  assert.ok(files[0].includes(r2.hash));
});

test('getOrRenderVoucherPdf: per-language variants stored separately', async (t) => {
  const bookingId = `cache-lang-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cleanup = () => {
    try {
      const dir = joinPath(process.cwd(), CACHE_DIR);
      const files = readdirSync(dir).filter((f) => f.startsWith(bookingId + '__'));
      for (const f of files) try { rmSync(joinPath(dir, f)); } catch {}
    } catch {}
  };
  t.after(cleanup);

  const v = { ...makeVoucher(), id: bookingId };
  const id = await getOrRenderVoucherPdf({ bookingId, voucher: v, lang: 'id' });
  const en = await getOrRenderVoucherPdf({ bookingId, voucher: v, lang: 'en' });
  assert.equal(id.cached, false);
  assert.equal(en.cached, false, 'different lang → different file');

  // Both files exist
  const dir = joinPath(process.cwd(), CACHE_DIR);
  const files = readdirSync(dir).filter((f) => f.startsWith(bookingId + '__'));
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.includes('__id__')));
  assert.ok(files.some((f) => f.includes('__en__')));
});
