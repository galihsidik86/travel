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
export async function streamBookingBundle(voucher, res, { format = 'pdf' } = {}) {
  const baseName = `booking_${voucher.bookingNo.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const suffix = format === 'csv' ? '_csv' : '';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}${suffix}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[bundle] archiver warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[bundle] archiver error:', err);
    res.destroy(err);
  });
  archive.pipe(res);

  // 1. Primary document(s) — PDF (default) or CSV trio (accounting flow)
  if (format === 'csv') {
    archive.append(buildBookingCsv(voucher), { name: 'booking.csv' });
    archive.append(buildPaymentsCsv(voucher), { name: 'payments.csv' });
    // docs.csv listed below alongside the doc files
  } else {
    // streamVoucherPdf calls `res.setHeader` + `doc.pipe(res)`. Provide a
    // shim that's a writable stream (so pdfkit.pipe works) AND has
    // setHeader as a no-op (the real zip headers were already set above).
    class ResShim extends PassThrough { setHeader() { /* noop */ } }
    const pdfShim = new ResShim();
    archive.append(pdfShim, { name: 'voucher.pdf' });
    streamVoucherPdf(voucher, pdfShim);
  }

  // 2. calendar.ics (skipped in CSV mode — calendar imports don't pair
  //    with accounting exports; the cleaner separation keeps the bundle
  //    purpose-built).
  const ics = format === 'csv' ? null : renderIcsFromBooking(voucher);
  if (ics) archive.append(ics.body, { name: 'calendar.ics' });

  // 3. docs/ — copy each file from disk (always included regardless of format)
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

  if (format === 'csv') {
    // docs.csv lets accountant audit which doc rows existed regardless
    // of whether the file blob was on disk.
    archive.append(buildDocsCsv(docs), { name: 'docs.csv' });
  }

  // 4. MANIFEST.txt — human-readable index
  const manifest = buildManifest(voucher, ics, includedDocs, missingDocs, format);
  archive.append(manifest, { name: 'MANIFEST.txt' });

  await archive.finalize();
}

// ─── CSV builders (S106) ───────────────────────────────────────
// RFC 4180-style quoting: any value containing ",", quote, or newline
// gets wrapped in double quotes with embedded quotes doubled. UTF-8 BOM
// prepended so Excel auto-detects encoding.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(arr) { return arr.map(csvCell).join(',') + '\r\n'; }

function buildBookingCsv(v) {
  const t = v.totals;
  const headers = [
    'bookingNo', 'status', 'kelas', 'paxCount',
    'jemaahName', 'jemaahPhone', 'jemaahEmail', 'passportNo', 'passportExpiry',
    'paketTitle', 'paketSlug', 'departureDate', 'returnDate', 'airline', 'routeFrom', 'routeTo',
    'room', 'agentSlug', 'agentDisplayName',
    'totalAmount', 'paidAmount', 'remaining', 'paidPct',
    'createdAt', 'notes', 'generatedAt',
  ];
  const row = [
    v.bookingNo, v.status, v.kelas, v.paxCount,
    v.jemaah?.fullName, v.jemaah?.phone, v.jemaah?.email,
    v.jemaah?.passportNo, isoDate(v.jemaah?.passportExpiry),
    v.paket?.title, v.paket?.slug, isoDate(v.paket?.departureDate), isoDate(v.paket?.returnDate),
    v.paket?.airline, v.paket?.routeFrom, v.paket?.routeTo,
    v.room?.roomNo, v.agent?.slug, v.agent?.displayName,
    t.totalAmount, t.paidAmount, t.remaining, t.paidPct,
    isoDate(v.createdAt), v.notes, isoDate(v.generatedAt),
  ];
  return '\ufeff' + csvRow(headers) + csvRow(row);
}

function buildPaymentsCsv(v) {
  const headers = ['createdAt', 'method', 'status', 'currency', 'amount', 'notes'];
  const rows = (v.payments || []).map((p) => [
    isoDate(p.createdAt), p.method, p.status, p.currency,
    p.amount?.toString?.() ?? p.amount,
    p.notes || '',
  ]);
  return '\ufeff' + csvRow(headers) + rows.map(csvRow).join('');
}

function buildDocsCsv(docs) {
  const headers = ['id', 'type', 'status', 'refNumber', 'submittedAt', 'verifiedAt', 'fileName', 'fileSize', 'mimeType'];
  const rows = (docs || []).map((d) => [
    d.id, d.type, d.status, d.refNumber || '',
    isoDate(d.submittedAt), isoDate(d.verifiedAt),
    d.fileName || '', d.fileSize || '', d.mimeType || '',
  ]);
  return '\ufeff' + csvRow(headers) + rows.map(csvRow).join('');
}

function isoDate(d) { return d ? new Date(d).toISOString() : ''; }

/**
 * Stage 107 — bulk dossier ZIP. Packages MULTIPLE bookings into one zip
 * with each booking under its own folder named by bookingNo.
 *
 *   bookings/<bookingNo>/voucher.pdf
 *   bookings/<bookingNo>/calendar.ics
 *   bookings/<bookingNo>/docs/<id>__<name>
 *   bookings/<bookingNo>/booking.csv (csv mode)
 *   BUNDLES_MANIFEST.txt
 *
 * Each per-booking subtree mirrors the single-booking shape exactly,
 * so a vendor handed a slice of the zip can use it standalone. CSV mode
 * passes through per-booking — uniform shape across the bundle.
 */
export async function streamBulkBookingBundle({ vouchers, paketTitle = '' }, res, { format = 'pdf' } = {}) {
  if (!vouchers || vouchers.length === 0) {
    res.status(400).type('text/plain').send('Tidak ada booking dipilih');
    return;
  }
  const safeTitle = (paketTitle || 'paket').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const baseName = `bundles_${safeTitle}_${vouchers.length}${format === 'csv' ? '_csv' : ''}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[bundle:bulk] archiver warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[bundle:bulk] archiver error:', err);
    res.destroy(err);
  });
  archive.pipe(res);

  const summaryLines = [
    `RELIGIO PRO — BULK BOOKING DOSSIERS (${format.toUpperCase()})`,
    '═══════════════════════════════════════════',
    '',
    `Paket:       ${paketTitle || '—'}`,
    `Bookings:    ${vouchers.length}`,
    `Generated:   ${new Date().toISOString()}`,
    '',
    'CONTENTS',
    '─────────',
  ];

  for (const v of vouchers) {
    const folder = `bookings/${v.bookingNo.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    summaryLines.push(`  ${folder}/ — ${v.jemaah?.fullName || '—'} · ${v.status}`);

    if (format === 'csv') {
      archive.append(buildBookingCsv(v), { name: `${folder}/booking.csv` });
      archive.append(buildPaymentsCsv(v), { name: `${folder}/payments.csv` });
    } else {
      class ResShim extends PassThrough { setHeader() { /* noop */ } }
      const pdfShim = new ResShim();
      archive.append(pdfShim, { name: `${folder}/voucher.pdf` });
      streamVoucherPdf(v, pdfShim);
    }

    if (format !== 'csv') {
      const ics = renderIcsFromBooking(v);
      if (ics) archive.append(ics.body, { name: `${folder}/calendar.ics` });
    }

    const docs = v.jemaah?.documents || [];
    for (const d of docs) {
      if (!d.filePath || !existsSync(d.filePath)) continue;
      const safe = (d.fileName || `${d.id}.bin`).replace(/[^A-Za-z0-9._-]/g, '_');
      archive.file(d.filePath, { name: `${folder}/docs/${d.id}__${safe}` });
    }
    if (format === 'csv') {
      archive.append(buildDocsCsv(docs), { name: `${folder}/docs.csv` });
    }
  }

  archive.append(summaryLines.join('\n'), { name: 'BUNDLES_MANIFEST.txt' });
  await archive.finalize();
}

function buildManifest(voucher, ics, includedDocs, missingDocs, format = 'pdf') {
  const lines = [
    `RELIGIO PRO — BOOKING DOSSIER (${format.toUpperCase()})`,
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
  ];
  if (format === 'csv') {
    lines.push('  booking.csv       — Booking + jemaah + paket + totals (S106)');
    lines.push('  payments.csv      — Payment history (S106)');
    lines.push('  docs.csv          — Document metadata (S106)');
  } else {
    lines.push('  voucher.pdf       — PDF voucher (S101)');
  }
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
