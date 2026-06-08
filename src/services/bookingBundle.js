// Stage 105 — package voucher.pdf + calendar.ics + all jemaah docs into
// one ZIP file. Saves admin from clicking 5 separate downloads when
// handing off a paket dossier to a vendor or partner.
//
// Bundle layout inside the ZIP:
//
//   voucher.pdf            — programmatic PDF render (S101)
//   calendar.ics           — RFC 5545 VEVENT (S72)
//   docs/<doc-id>__<sanitized-name>.<ext>   — each verified+submitted file
//   MANIFEST.txt           — human-readable index of contents
//
// Streamed directly to the response — no temp file on disk. archiver
// pipes into res; pdfkit pipes into archiver via PassThrough.
//
// Only includes files that actually exist on disk (some legacy docs may
// have a `filePath` row but the blob is gone). Missing files logged but
// don't abort the bundle.

import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
// archiver v8+ is pure ESM and exposes named classes instead of the old
// factory function. Construct the ZipArchive directly.
import { ZipArchive } from 'archiver';

import { db } from '../lib/db.js';
import { renderIcsFromBooking } from './bookingIcs.js';
import { streamVoucherPdf } from './bookingVoucherPdf.js';

/**
 * Stream a booking dossier ZIP to `res`. Requires `voucher` (output of
 * getAdminBookingVoucher). The voucher must include `jemaah.documents`
 * (with filePath) and `paket` (with departureDate + returnDate) for full
 * coverage. Missing optional pieces just shrink the bundle.
 *
 * @param {object} voucher   getAdminBookingVoucher result
 * @param {object} res       Express response
 */
export async function streamBookingBundle(voucher, res) {
  const baseName = `booking_${voucher.bookingNo.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[bundle] archiver warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[bundle] archiver error:', err);
    // The response may already have started — best we can do is destroy.
    res.destroy(err);
  });
  archive.pipe(res);

  // 1. voucher.pdf — streamVoucherPdf calls `res.setHeader` + `doc.pipe(res)`.
  //    Provide a shim that's a writable stream (so pdfkit.pipe works) AND
  //    has setHeader as a no-op (so the header writes don't blow up — the
  //    real zip headers we already set on the response above).
  class ResShim extends PassThrough { setHeader() { /* noop */ } }
  const pdfShim = new ResShim();
  archive.append(pdfShim, { name: 'voucher.pdf' });
  streamVoucherPdf(voucher, pdfShim);
  // pdfkit ends the writable when done → archiver finalises that entry.

  // 2. calendar.ics (if dates available)
  const ics = renderIcsFromBooking(voucher);
  if (ics) {
    archive.append(ics.body, { name: 'calendar.ics' });
  }

  // 3. docs/ — copy each file from disk
  const docs = voucher.jemaah?.documents || await db.jemaahDocument.findMany({
    where: { jemaahId: voucher.jemaahId },
    select: { id: true, type: true, filePath: true, fileName: true, mimeType: true, status: true },
  });
  const includedDocs = [];
  const missingDocs = [];
  for (const d of docs) {
    if (!d.filePath) continue;
    if (!existsSync(d.filePath)) {
      missingDocs.push({ id: d.id, type: d.type, path: d.filePath });
      continue;
    }
    const safe = (d.fileName || `${d.id}.bin`).replace(/[^A-Za-z0-9._-]/g, '_');
    archive.file(d.filePath, { name: `docs/${d.id}__${safe}` });
    includedDocs.push({ id: d.id, type: d.type, name: safe, status: d.status });
  }

  // 4. MANIFEST.txt — human-readable summary so the recipient can sanity-check
  const manifest = buildManifest(voucher, ics, includedDocs, missingDocs);
  archive.append(manifest, { name: 'MANIFEST.txt' });

  await archive.finalize();
}

function buildManifest(voucher, ics, includedDocs, missingDocs) {
  const lines = [
    'RELIGIO PRO — BOOKING DOSSIER',
    '═══════════════════════════════════════════',
    '',
    `Booking:     ${voucher.bookingNo}`,
    `Status:      ${voucher.status}`,
    `Jemaah:      ${voucher.jemaah?.fullName || '—'}`,
    `Telepon:     ${voucher.jemaah?.phone || '—'}`,
    `Paket:       ${voucher.paket?.title || '—'}`,
    `Kelas:       ${voucher.kelas} · ${voucher.paxCount} PAX`,
    '',
    'CONTENTS',
    '─────────',
    '  voucher.pdf       — PDF voucher (S101)',
  ];
  if (ics) lines.push('  calendar.ics      — Calendar event (S72)');
  if (includedDocs.length > 0) {
    lines.push('  docs/             — Jemaah documents:');
    for (const d of includedDocs) {
      lines.push(`    · ${d.type} (${d.status}) — ${d.name}`);
    }
  }
  if (missingDocs.length > 0) {
    lines.push('');
    lines.push('NOT INCLUDED (file missing on disk)');
    lines.push('─────────');
    for (const d of missingDocs) {
      lines.push(`  · ${d.type} — record exists, file unavailable`);
    }
  }
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  return lines.join('\n');
}
