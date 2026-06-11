// Stage 101 — programmatic A4 PDF rendering of the booking voucher.
// Stage 103 — branding lift (ornament header) + i18n (id/en/ar-romanised).
//
// Why pdfkit and not headless Chromium (puppeteer/playwright):
//   - pdfkit ~100KB pure-JS, no native bins, no manual `playwright install`
//   - Chromium would dwarf the actual project size + add cold-start overhead
//   - The voucher layout is structured enough to render programmatically
//     in <250 lines without losing fidelity
//
// Layout mirrors the HTML print view (S20) loosely:
//   header  Ornamental brand mark with gold rule + booking number + status
//   blocks  Jemaah identity / Perjalanan / Pembayaran / Itinerary / Agen
//   footer  generated timestamp + blessing line per locale

import PDFDocument from 'pdfkit';
import { drawQrCode } from '../lib/qrPdfRender.js';
import { buildVerifyUrl } from '../lib/voucherVerifyToken.js';

const COLORS = {
  ink: '#0a0908',
  cream: '#f5f1e8',
  gold: '#d4af37',
  green: '#4a8f6d',
  ruby: '#b5564a',
  muted: '#6b6358',
  sub: '#3b332c',
};

// Stage 103 — i18n strings. Arabic uses romanised glyphs because Helvetica
// (PDF default) lacks Arabic coverage and bundling Amiri (~400KB) would
// dwarf the rest of the repo for marginal benefit on a voucher. If real
// Arabic glyphs ever become a hard requirement, register a TTF via
// `doc.registerFont('Amiri', '/path/to/Amiri-Regular.ttf')`.
const LANGS = {
  id: {
    subtitle: 'Voucher Booking',
    sJemaah: 'JEMAAH', sJourney: 'PERJALANAN', sPayment: 'PEMBAYARAN',
    sAgent: 'AGEN PENDAMPING', sItin: 'ITINERARY (RINGKAS)',
    name: 'Nama', phone: 'Telepon', email: 'Email', passport: 'Paspor',
    paket: 'Paket', kelas: 'Kelas', depart: 'Berangkat', return_: 'Pulang',
    airline: 'Maskapai', route: 'Rute', room: 'Kamar',
    total: 'Total', paid: 'Sudah dibayar', remaining: 'Sisa', history: 'Riwayat:',
    wa: 'WhatsApp', moreDays: (n) => `+ ${n} hari lainnya…`,
    footer: 'Dibuat',
    fineprint: 'Voucher tidak dapat dialihkan tanpa konfirmasi tim.',
    blessing: 'Semoga perjalanan Anda diberkahi.',
  },
  en: {
    subtitle: 'Booking Voucher',
    sJemaah: 'PILGRIM', sJourney: 'JOURNEY', sPayment: 'PAYMENT',
    sAgent: 'AGENT', sItin: 'ITINERARY (SUMMARY)',
    name: 'Name', phone: 'Phone', email: 'Email', passport: 'Passport',
    paket: 'Package', kelas: 'Class', depart: 'Departure', return_: 'Return',
    airline: 'Airline', route: 'Route', room: 'Room',
    total: 'Total', paid: 'Paid so far', remaining: 'Remaining', history: 'History:',
    wa: 'WhatsApp', moreDays: (n) => `+ ${n} more days…`,
    footer: 'Issued',
    fineprint: 'Voucher non-transferable without team confirmation.',
    blessing: 'May your journey be blessed.',
  },
  ar: {
    subtitle: 'Wathiqat al-Hajz',
    sJemaah: 'AL-HAAJ', sJourney: 'AL-RIHLAH', sPayment: 'AL-DAFAA',
    sAgent: 'AL-WAKEEL', sItin: 'JADWAL AL-RIHLAH',
    name: 'Al-Ism', phone: 'Al-Haatif', email: 'Bareed', passport: 'Jawaaz al-Safar',
    paket: 'Al-Bernamej', kelas: 'Al-Daraja', depart: 'Al-Mughadara', return_: 'Al-Iyaab',
    airline: 'Sharikat al-Tayaraan', route: 'Al-Masaar', room: 'Al-Ghurfa',
    total: 'Al-Majmoo', paid: 'Al-Madfoo', remaining: 'Al-Baaqi', history: 'Al-Sajl:',
    wa: 'WhatsApp', moreDays: (n) => `+ ${n} ayyaam ukhraa…`,
    footer: 'Tariikh',
    fineprint: "Hadhihi al-wathiqat ghair qaabilatun lil-tahweel bidoon ta-aakeed al-fariq.",
    blessing: "Baarakallahu fiikum wa-ja'ala hajjakum mabroor.",
  },
};

function pickLang(lang) {
  const key = (lang || 'id').toString().toLowerCase();
  return LANGS[key] ? key : 'id';
}

function fmtIdr(n) {
  return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
}
function fmtDate(d, lang) {
  if (!d) return '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'ar' ? 'en-GB' : 'id-ID';
  return new Date(d).toLocaleDateString(locale, {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/**
 * Render a voucher PDF and stream to `res`.
 *
 * @param {object} voucher  output of getJemaahBookingVoucher / getAdminBookingVoucher
 * @param {object} res      express response — must support .setHeader + .pipe
 * @param {object} [opts]
 * @param {string} [opts.lang='id']  one of 'id' | 'en' | 'ar' (romanised)
 */
export function streamVoucherPdf(voucher, res, opts = {}) {
  const lang = pickLang(opts.lang);
  const filename = voucherFilename(voucher, lang);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = newVoucherDoc(voucher, lang);
  doc.pipe(res);
  renderVoucherIntoDoc(doc, voucher, lang);
  doc.end();
}

/**
 * Stage 149 — produce the voucher PDF as an in-memory Buffer instead of
 * streaming to res. Used by the voucher cache + the bookingBundle.zip
 * flow that needs the bytes for archival.
 */
export async function renderVoucherPdfBuffer(voucher, opts = {}) {
  const lang = pickLang(opts.lang);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = newVoucherDoc(voucher, lang);
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      renderVoucherIntoDoc(doc, voucher, lang);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Stage 149 — filename helper exported so the cache can name files
 * the same way the download attachment is named.
 */
export function voucherFilename(voucher, lang = 'id') {
  const langKey = pickLang(lang);
  const cleanNo = voucher.bookingNo.replace(/[^A-Za-z0-9_-]/g, '_');
  return `voucher_${cleanNo}${langKey !== 'id' ? '_' + langKey : ''}.pdf`;
}

function newVoucherDoc(voucher, lang) {
  return new PDFDocument({
    size: 'A4', margin: 50,
    info: {
      Title: `Voucher ${voucher.bookingNo}`,
      Author: 'Religio Pro',
      Subject: 'Booking voucher',
      Keywords: `lang:${lang}`,
    },
  });
}

/**
 * Stage 149 — pure rendering function. Caller owns the PDFDocument
 * lifecycle (stream piping + doc.end()), so this function can serve
 * both `streamVoucherPdf` (pipe→res) and `renderVoucherPdfBuffer`
 * (chunks→Buffer) without duplicating the layout.
 */
function renderVoucherIntoDoc(doc, voucher, lang) {
  const L = LANGS[lang];

  // ── Header (Stage 103 ornament) ───────────────────────────
  // Top gold rule
  doc.strokeColor(COLORS.gold).lineWidth(1.5).moveTo(50, 50).lineTo(545, 50).stroke();
  doc.moveDown(0.4);
  // Brand mark (large, centered)
  doc.font('Helvetica-Bold').fontSize(24).fillColor(COLORS.ink)
    .text('RELIGIO PRO', 50, 60, { width: 495, align: 'center', characterSpacing: 4 });
  // Diamond divider
  doc.fontSize(10).fillColor(COLORS.gold)
    .text('◆', 50, 90, { width: 495, align: 'center' });
  // Subtitle (per-lang)
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted)
    .text(L.subtitle.toUpperCase() + ' · ' + fmtDate(voucher.generatedAt, lang),
      50, 105, { width: 495, align: 'center', characterSpacing: 2 });
  // Bottom hairline
  doc.strokeColor(COLORS.gold).lineWidth(0.5)
    .moveTo(50, 125).lineTo(545, 125).stroke();

  doc.y = 140;

  // Stage 195 + 197 — QR code in the top-right encoding the public
  // verification URL (HMAC-signed). Anyone scanning lands on a small
  // page confirming the voucher is real, without needing admin auth.
  // Best-effort — QR failure logs but doesn't break the voucher PDF.
  try {
    const qrUrl = buildVerifyUrl(voucher.id);
    drawQrCode(doc, qrUrl, { x: 460, y: 140, size: 80 });
    // Tiny caption below the QR
    doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted)
      .text('SCAN UNTUK VERIFIKASI', 460, 225, { width: 80, align: 'center', characterSpacing: 1 });
  } catch (err) {
    console.warn('[voucher-qr] render failed:', err?.message || err);
  }

  // Booking number + status (big, left-aligned)
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.gold)
    .text(voucher.bookingNo, { continued: true });
  doc.font('Helvetica').fontSize(11).fillColor(COLORS.ink)
    .text(`   ·   ${voucher.status}`);
  doc.moveDown(0.8);

  // ── Jemaah block ──────────────────────────────────────────
  section(doc, L.sJemaah);
  field(doc, L.name, voucher.jemaah?.fullName || '—');
  field(doc, L.phone, voucher.jemaah?.phone || '—');
  if (voucher.jemaah?.email) field(doc, L.email, voucher.jemaah.email);
  if (voucher.jemaah?.passportNo) {
    field(doc, L.passport,
      `${voucher.jemaah.passportNo}${voucher.jemaah.passportExpiry ? ' · expire ' + fmtDate(voucher.jemaah.passportExpiry, lang) : ''}`);
  }
  doc.moveDown(0.6);

  // ── Perjalanan / Journey block ────────────────────────────
  section(doc, L.sJourney);
  field(doc, L.paket, voucher.paket?.title || '—');
  field(doc, L.kelas, `${voucher.kelas} · ${voucher.paxCount} PAX`);
  field(doc, L.depart, fmtDate(voucher.paket?.departureDate, lang));
  field(doc, L.return_, fmtDate(voucher.paket?.returnDate, lang));
  if (voucher.paket?.airline) field(doc, L.airline, voucher.paket.airline);
  if (voucher.paket?.routeFrom || voucher.paket?.routeTo) {
    field(doc, L.route, `${voucher.paket?.routeFrom || '?'} → ${voucher.paket?.routeTo || '?'}`);
  }
  if (voucher.room) field(doc, L.room, voucher.room.roomNo || '—');
  doc.moveDown(0.6);

  // ── Payment block ─────────────────────────────────────────
  section(doc, L.sPayment);
  const t = voucher.totals;
  field(doc, L.total, fmtIdr(t.totalAmount));
  field(doc, L.paid, fmtIdr(t.paidAmount) + `  (${t.paidPct}%)`);
  field(doc, L.remaining, fmtIdr(t.remaining), t.remaining > 0 ? COLORS.ruby : COLORS.green);

  if (voucher.payments && voucher.payments.length > 0) {
    doc.moveDown(0.3).fontSize(9).fillColor(COLORS.muted).text(L.history);
    voucher.payments.slice(0, 8).forEach((p) => {
      const amt = Number(p.amount.toString());
      const sign = amt < 0 ? '−' : '';
      doc.fontSize(9).fillColor(amt < 0 ? COLORS.ruby : COLORS.sub)
        .text(`  ${fmtDate(p.createdAt, lang)}  ·  ${sign}${fmtIdr(Math.abs(amt))}  ·  ${p.method}  ·  ${p.status}`);
    });
  }
  doc.moveDown(0.6);

  // ── Agent block ───────────────────────────────────────────
  if (voucher.agent) {
    section(doc, L.sAgent);
    field(doc, L.name, voucher.agent.displayName || voucher.agent.slug || '—');
    if (voucher.agent.whatsapp) field(doc, L.wa, voucher.agent.whatsapp);
    doc.moveDown(0.6);
  }

  // ── Itinerary (compressed) ────────────────────────────────
  if (voucher.paket?.days && voucher.paket.days.length > 0) {
    section(doc, L.sItin);
    voucher.paket.days.slice(0, 10).forEach((d) => {
      doc.fontSize(9).fillColor(COLORS.sub)
        .text(`  Day ${d.dayNumber}  ·  ${d.title}`);
    });
    if (voucher.paket.days.length > 10) {
      doc.fontSize(9).fillColor(COLORS.muted)
        .text(`  ${L.moreDays(voucher.paket.days.length - 10)}`);
    }
    doc.moveDown(0.6);
  }

  // ── Footer (Stage 103 — blessing + fineprint, centered) ──
  const footY = doc.page.height - 80;
  doc.strokeColor(COLORS.gold).lineWidth(0.4)
    .moveTo(120, footY - 8).lineTo(475, footY - 8).stroke();

  doc.font('Helvetica-Oblique').fontSize(10).fillColor(COLORS.gold)
    .text(L.blessing, 50, footY, { width: 495, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
    .text(`${L.footer} ${fmtDate(voucher.generatedAt, lang)} · Religio Pro · ${L.fineprint}`,
      50, footY + 18, { width: 495, align: 'center' });
}

function section(doc, title) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.gold)
    .text(title, { characterSpacing: 1.5 });
  doc.moveDown(0.15);
}

function field(doc, label, value, valueColor = COLORS.ink) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(label, 50, y, { width: 110 });
  doc.font('Helvetica').fontSize(11).fillColor(valueColor)
    .text(String(value), 165, y, { width: 380 });
}

export { LANGS, pickLang };
