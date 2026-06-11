// Stage 195 — QR code rendering helper for pdfkit. Uses the
// `qrcode` package's synchronous `create()` API to produce a module
// matrix, then draws filled rectangles directly into the PDFDocument.
//
// We pick errorCorrectionLevel='M' (~15% recovery) as the default —
// good balance for printed vouchers where a coffee spill or small
// fold can damage the matrix.

import qrcode from 'qrcode';

/**
 * Draw a QR code at (x, y) with `size` width/height (in pdfkit points).
 *
 * @param {PDFDocument} doc — pdfkit document
 * @param {string} text — payload to encode
 * @param {object} opts — { x, y, size, errorCorrectionLevel='M', dark='#000', light=null }
 *   - `light=null` means transparent background (default — caller's
 *     background shows through, important for non-white voucher).
 */
export function drawQrCode(doc, text, {
  x = 50, y = 50, size = 80,
  errorCorrectionLevel = 'M',
  dark = '#000',
  light = null,
} = {}) {
  if (!text) return;
  const qr = qrcode.create(text, { errorCorrectionLevel });
  const modules = qr.modules;
  const moduleSize = size / modules.size;

  if (light) {
    doc.save().fillColor(light).rect(x, y, size, size).fill().restore();
  }

  doc.save().fillColor(dark);
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      // modules.data is a Uint8Array, row-major
      if (modules.data[row * modules.size + col]) {
        doc.rect(
          x + col * moduleSize,
          y + row * moduleSize,
          moduleSize, moduleSize,
        ).fill();
      }
    }
  }
  doc.restore();
}

/**
 * Return the matrix size in modules for a given text — handy in tests
 * for verifying the QR is being generated. The actual rendered pixel
 * dimensions are `size` (input), independent of module count.
 */
export function qrModuleSize(text, errorCorrectionLevel = 'M') {
  if (!text) return 0;
  const qr = qrcode.create(text, { errorCorrectionLevel });
  return qr.modules.size;
}
