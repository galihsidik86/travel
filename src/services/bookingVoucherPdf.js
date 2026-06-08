// Stage 101 — programmatic A4 PDF rendering of the booking voucher.
//
// Why pdfkit and not headless Chromium (puppeteer/playwright):
//   - pdfkit ~100KB pure-JS, no native bins, no manual `playwright install`
//   - Chromium would dwarf the actual project size + add cold-start overhead
//   - The voucher layout is structured enough to render programmatically
//     in <150 lines without losing fidelity
//
// Layout mirrors the HTML print view (S20) loosely:
//   header  Religio Pro brand + booking number + status pill
//   blocks  Jemaah identity / Perjalanan / Pembayaran / Itinerary / Agen
//   footer  generated timestamp + filename
//
// All amounts use Indonesian thousand separator; dates formatted via
// `Intl.DateTimeFormat('id-ID')`.

import PDFDocument from 'pdfkit';

const COLORS = {
  ink: '#0a0908',
  cream: '#f5f1e8',
  gold: '#d4af37',
  green: '#4a8f6d',
  ruby: '#b5564a',
  muted: '#6b6358',
  sub: '#3b332c',
};

function fmtIdr(n) {
  return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/**
 * Render a voucher PDF and stream to `res`. Sets Content-Type and a
 * download-friendly Content-Disposition based on the booking number.
 *
 * @param {object} voucher  output of getJemaahBookingVoucher / getAdminBookingVoucher
 * @param {object} res      express response — must support .setHeader + .pipe
 */
export function streamVoucherPdf(voucher, res) {
  const filename = `voucher_${voucher.bookingNo.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
    Title: `Voucher ${voucher.bookingNo}`,
    Author: 'Religio Pro',
    Subject: 'Booking voucher',
  } });
  doc.pipe(res);

  // ── Header ────────────────────────────────────────────────
  doc.fontSize(22).fillColor(COLORS.ink).text('RELIGIO PRO', { continued: false });
  doc.fontSize(10).fillColor(COLORS.muted)
    .text('Voucher Booking · ' + fmtDate(voucher.generatedAt));
  doc.moveDown(0.3);

  // Booking number + status
  doc.fontSize(16).fillColor(COLORS.gold).text(voucher.bookingNo, { continued: true });
  doc.fillColor(COLORS.ink).fontSize(11).text(`   ·   ${voucher.status}`);
  doc.moveDown(0.6);

  // Horizontal rule
  const rulY = doc.y;
  doc.strokeColor(COLORS.gold).lineWidth(0.5).moveTo(50, rulY).lineTo(545, rulY).stroke();
  doc.moveDown(0.8);

  // ── Jemaah block ──────────────────────────────────────────
  section(doc, 'JEMAAH');
  field(doc, 'Nama', voucher.jemaah?.fullName || '—');
  field(doc, 'Telepon', voucher.jemaah?.phone || '—');
  if (voucher.jemaah?.email) field(doc, 'Email', voucher.jemaah.email);
  if (voucher.jemaah?.passportNo) field(doc, 'Paspor', `${voucher.jemaah.passportNo}${voucher.jemaah.passportExpiry ? ' · expire ' + fmtDate(voucher.jemaah.passportExpiry) : ''}`);
  doc.moveDown(0.6);

  // ── Perjalanan block ──────────────────────────────────────
  section(doc, 'PERJALANAN');
  field(doc, 'Paket', voucher.paket?.title || '—');
  field(doc, 'Kelas', `${voucher.kelas} · ${voucher.paxCount} PAX`);
  field(doc, 'Berangkat', fmtDate(voucher.paket?.departureDate));
  field(doc, 'Pulang', fmtDate(voucher.paket?.returnDate));
  if (voucher.paket?.airline) field(doc, 'Maskapai', voucher.paket.airline);
  if (voucher.paket?.routeFrom || voucher.paket?.routeTo) {
    field(doc, 'Rute', `${voucher.paket?.routeFrom || '?'} → ${voucher.paket?.routeTo || '?'}`);
  }
  if (voucher.room) field(doc, 'Kamar', voucher.room.roomNo || '—');
  doc.moveDown(0.6);

  // ── Pembayaran block ──────────────────────────────────────
  section(doc, 'PEMBAYARAN');
  const t = voucher.totals;
  field(doc, 'Total', fmtIdr(t.totalAmount));
  field(doc, 'Sudah dibayar', fmtIdr(t.paidAmount) + `  (${t.paidPct}%)`);
  field(doc, 'Sisa', fmtIdr(t.remaining), t.remaining > 0 ? COLORS.ruby : COLORS.green);

  if (voucher.payments && voucher.payments.length > 0) {
    doc.moveDown(0.3).fontSize(9).fillColor(COLORS.muted).text('Riwayat:');
    voucher.payments.slice(0, 8).forEach((p) => {
      const amt = Number(p.amount.toString());
      const sign = amt < 0 ? '−' : '';
      doc.fontSize(9).fillColor(amt < 0 ? COLORS.ruby : COLORS.sub)
        .text(`  ${fmtDate(p.createdAt)}  ·  ${sign}${fmtIdr(Math.abs(amt))}  ·  ${p.method}  ·  ${p.status}`);
    });
  }
  doc.moveDown(0.6);

  // ── Agen block ────────────────────────────────────────────
  if (voucher.agent) {
    section(doc, 'AGEN PENDAMPING');
    field(doc, 'Nama', voucher.agent.displayName || voucher.agent.slug || '—');
    if (voucher.agent.whatsapp) field(doc, 'WhatsApp', voucher.agent.whatsapp);
    doc.moveDown(0.6);
  }

  // ── Itinerary (compressed) ────────────────────────────────
  if (voucher.paket?.days && voucher.paket.days.length > 0) {
    section(doc, 'ITINERARY (RINGKAS)');
    voucher.paket.days.slice(0, 10).forEach((d) => {
      doc.fontSize(9).fillColor(COLORS.sub)
        .text(`  Day ${d.dayNumber}  ·  ${d.title}`, { continued: false });
    });
    if (voucher.paket.days.length > 10) {
      doc.fontSize(9).fillColor(COLORS.muted).text(`  + ${voucher.paket.days.length - 10} hari lainnya…`);
    }
    doc.moveDown(0.6);
  }

  // ── Footer ────────────────────────────────────────────────
  doc.fontSize(8).fillColor(COLORS.muted).text(
    `Dibuat ${fmtDate(voucher.generatedAt)} · Religio Pro · Voucher tidak dapat dialihkan tanpa konfirmasi tim.`,
    50, doc.page.height - 60, { width: 495, align: 'center' },
  );

  doc.end();
}

function section(doc, title) {
  doc.fontSize(9).fillColor(COLORS.gold).text(title, { continued: false });
  doc.moveDown(0.15);
}

function field(doc, label, value, valueColor = COLORS.ink) {
  // Two-column row: label left (120 wide), value right.
  const y = doc.y;
  doc.fontSize(9).fillColor(COLORS.muted).text(label, 50, y, { width: 110, continued: false });
  doc.fontSize(11).fillColor(valueColor).text(String(value), 165, y, { width: 380, continued: false });
}
