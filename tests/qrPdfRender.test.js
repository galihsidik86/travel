// Stage 195 — QR code rendering helper for pdfkit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';

import { drawQrCode, qrModuleSize } from '../src/lib/qrPdfRender.js';

test('qrModuleSize: empty text → 0', () => {
  assert.equal(qrModuleSize(''), 0);
  assert.equal(qrModuleSize(null), 0);
});

test('qrModuleSize: short text → ~21 modules', () => {
  // QR version 1 with M-level EC fits ~14 alphanumeric chars at size 21
  const size = qrModuleSize('hello');
  assert.equal(size, 21);
});

test('qrModuleSize: longer text → larger matrix', () => {
  const small = qrModuleSize('x');
  const large = qrModuleSize('x'.repeat(200));
  assert.ok(large > small, 'long text needs more modules');
});

test('drawQrCode: empty text → no-op (no error)', () => {
  const doc = new PDFDocument();
  // Should not throw
  drawQrCode(doc, '');
  drawQrCode(doc, null);
});

test('drawQrCode: produces PDF content (buffer grows)', async () => {
  // Capture baseline empty-page PDF size, then a same-page with QR
  function renderPdf(addQr) {
    return new Promise((resolve) => {
      const doc = new PDFDocument();
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.font('Helvetica').text('header line', 50, 50);
      if (addQr) drawQrCode(doc, 'https://religio.pro/admin/bookings/abc123', { x: 100, y: 100, size: 100 });
      doc.end();
    });
  }
  const empty = await renderPdf(false);
  const withQr = await renderPdf(true);
  // QR adds many filled rectangles → withQr should be noticeably larger
  assert.ok(withQr.length > empty.length + 100, `with QR (${withQr.length}) > empty (${empty.length})`);
});

test('drawQrCode: light=null leaves transparent background (no fill rect drawn first)', async () => {
  function render(light) {
    return new Promise((resolve) => {
      const doc = new PDFDocument();
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      drawQrCode(doc, 'abc', { x: 50, y: 50, size: 80, light });
      doc.end();
    });
  }
  const transparent = await render(null);
  const whiteBg = await render('#fff');
  // Adding a background rect = at least one extra fill op
  assert.ok(whiteBg.length > transparent.length, 'opaque background adds bytes');
});
