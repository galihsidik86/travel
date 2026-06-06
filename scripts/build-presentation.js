// Religio Pro — PowerPoint deck generator.
//
// Usage:   node scripts/build-presentation.js
// Output:  presentation/religio-pro.pptx
//
// The deck covers technology, architecture, per-portal features, mobile +
// offline, print outputs, analytics, ops/security, and advantages. Slides
// that reference a UI screen carry a captioned image placeholder — drop
// PNGs into presentation/screenshots/ matching the filenames listed in
// presentation/SCREENSHOT-GUIDE.md and re-run this script to embed them.

import fs from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';

const OUT_DIR = path.resolve('presentation');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// ── Brand tokens (mirror shared/tokens.css onyx + gold) ──────
const COLORS = {
  ink1000: '050403',
  ink900:  '11100E',
  ink800:  '1C1A17',
  ink500:  '3A3630',
  ink200:  '8E8676',
  cream100:'F4EEDE',
  cream200:'EDE6D3',
  gold300: 'D4AF37',
  gold200: 'DCC36A',
  emerald: '4A8F6D',
  ruby:    'B5564A',
  amber:   'C9933B',
  sapphire:'4A6F8F',
};

const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5"
pres.title = 'Religio Pro — Travel Umroh & Haji Management';
pres.author = 'Religio Pro';
pres.company = 'Religio Pro';
pres.subject = 'System overview deck';

const W = 13.333;
const H = 7.5;

// ── Helpers ──────────────────────────────────────────────────
function darkBg(slide) {
  slide.background = { color: COLORS.ink1000 };
}

function eyebrow(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.6, y: 0.55, w: W - 1.2, h: 0.3,
    fontFace: 'Consolas', fontSize: 10, color: COLORS.gold300,
    charSpacing: 4, bold: true,
    ...opts,
  });
}

function title(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.6, y: 0.85, w: W - 1.2, h: 0.9,
    fontFace: 'Georgia', fontSize: 38, color: COLORS.cream100,
    bold: false, italic: false,
    ...opts,
  });
}

function subtitle(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.6, y: 1.7, w: W - 1.2, h: 0.35,
    fontFace: 'Consolas', fontSize: 11, color: COLORS.ink200,
    charSpacing: 2,
    ...opts,
  });
}

function divider(slide, y = 2.1) {
  slide.addShape('line', {
    x: 0.6, y, w: 2.0, h: 0,
    line: { color: COLORS.gold300, width: 2 },
  });
}

function bullet(slide, items, opts = {}) {
  const text = items.map((t) => ({
    text: t,
    options: { bullet: { type: 'bullet', code: '25CF', color: COLORS.gold300 } },
  }));
  slide.addText(text, {
    x: 0.6, y: 2.4, w: opts.w ?? W - 1.2, h: opts.h ?? H - 3.0,
    fontFace: 'Calibri', fontSize: 16, color: COLORS.cream100,
    lineSpacing: 26,
    paraSpaceAfter: 6,
    ...opts,
  });
}

function pageFooter(slide, num, total) {
  slide.addText('RELIGIO PRO · OVERVIEW', {
    x: 0.6, y: H - 0.5, w: 4, h: 0.3,
    fontFace: 'Consolas', fontSize: 9, color: COLORS.ink200, charSpacing: 4,
  });
  slide.addText(`${num} / ${total}`, {
    x: W - 1.6, y: H - 0.5, w: 1.0, h: 0.3, align: 'right',
    fontFace: 'Consolas', fontSize: 9, color: COLORS.ink200, charSpacing: 2,
  });
}

// Drop a screenshot if it exists; otherwise a captioned placeholder box.
function addScreenshot(slide, filename, { x, y, w, h, caption }) {
  const full = path.join(SHOTS_DIR, filename);
  if (fs.existsSync(full)) {
    slide.addImage({ path: full, x, y, w, h });
  } else {
    slide.addShape('rect', {
      x, y, w, h,
      fill: { color: COLORS.ink900 },
      line: { color: COLORS.ink500, width: 1, dashType: 'dash' },
    });
    slide.addText(`📸 SCREENSHOT\n${filename}\n\nDrop file into\npresentation/screenshots/`, {
      x: x + 0.2, y: y + (h / 2) - 0.6, w: w - 0.4, h: 1.2,
      fontFace: 'Consolas', fontSize: 11, color: COLORS.ink200, align: 'center',
      charSpacing: 1,
    });
  }
  if (caption) {
    slide.addText(caption, {
      x, y: y + h + 0.05, w, h: 0.3, align: 'center',
      fontFace: 'Consolas', fontSize: 10, color: COLORS.gold300, charSpacing: 2,
    });
  }
}

// ── Slides ───────────────────────────────────────────────────

const SLIDES = [];

// 01 — Title
SLIDES.push((slide) => {
  darkBg(slide);
  slide.addShape('rect', {
    x: 0, y: 0, w: W, h: H,
    fill: { color: COLORS.ink1000 },
  });
  // gold accent line top-left
  slide.addShape('rect', {
    x: 0.6, y: 0.6, w: 1.8, h: 0.04,
    fill: { color: COLORS.gold300 },
    line: { type: 'none' },
  });
  slide.addText('RELIGIO PRO', {
    x: 0.6, y: 0.9, w: W - 1.2, h: 0.6,
    fontFace: 'Consolas', fontSize: 14, color: COLORS.gold300, charSpacing: 8,
    bold: true,
  });
  slide.addText([
    { text: 'Sistem manajemen ', options: { color: COLORS.cream100 } },
    { text: 'travel umroh & haji', options: { color: COLORS.gold300, italic: true } },
  ], {
    x: 0.6, y: 1.7, w: W - 1.2, h: 1.8,
    fontFace: 'Georgia', fontSize: 60,
  });
  slide.addText('End-to-end · Web + PWA · Multi-role · Production-ready', {
    x: 0.6, y: 4.0, w: W - 1.2, h: 0.4,
    fontFace: 'Consolas', fontSize: 13, color: COLORS.cream200, charSpacing: 3,
  });
  slide.addText([
    { text: 'Backend ', options: { color: COLORS.ink200 } },
    { text: 'Node.js 20 · Express · Prisma · MySQL', options: { color: COLORS.cream100 } },
    { text: '\nFrontend ', options: { color: COLORS.ink200 } },
    { text: 'EJS · PWA Service Worker · IndexedDB · Web Push', options: { color: COLORS.cream100 } },
    { text: '\nIntegrasi ', options: { color: COLORS.ink200 } },
    { text: 'Midtrans Snap · Fonnte WA · SMTP · sharp · web-push', options: { color: COLORS.cream100 } },
  ], {
    x: 0.6, y: 5.0, w: W - 1.2, h: 1.6,
    fontFace: 'Consolas', fontSize: 12, lineSpacing: 22, charSpacing: 1,
  });
  slide.addText('Religio Pro Engineering · Overview Deck', {
    x: 0.6, y: H - 0.5, w: W - 1.2, h: 0.3,
    fontFace: 'Consolas', fontSize: 9, color: COLORS.ink200, charSpacing: 4,
  });
});

// 02 — Apa itu Religio Pro
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '01 · INTRODUKSI');
  title(slide, 'Apa itu Religio Pro');
  subtitle(slide, 'Platform terintegrasi yang mendigitalkan setiap titik kontak dalam bisnis travel umroh & haji');
  divider(slide);
  bullet(slide, [
    'Satu sistem untuk owner, manajer ops, kasir, agen, muthawwif (crew), dan jemaah — 8 role RBAC.',
    'Lead → Booking → Payment → Komisi → Payout dijalankan otomatis di satu pipeline.',
    'Web-based + Progressive Web App: bisa di-install seperti aplikasi native di HP jemaah & crew.',
    'Bahasa Indonesia di seluruh UI (lang="id"). Tema "premium VVIP" — onyx + gold + cream.',
    'Production-ready: rate limit, CSRF, audit log permanen, retention policy, backup nightly.',
  ]);
});

// 03 — Tech Stack
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '02 · TEKNOLOGI');
  title(slide, 'Stack & Dependensi');
  subtitle(slide, 'Pilihan teknologi yang battle-tested + ekosistem npm yang sehat');
  divider(slide);

  const categories = [
    { title: 'BACKEND', items: ['Node.js ≥ 20.6', 'Express 4', 'Prisma 6', 'MySQL / MariaDB', 'Zod (validation)', 'JWT (HS256)', 'bcrypt'] },
    { title: 'FRONTEND', items: ['EJS templating', 'CSS custom-props', 'Service Worker', 'IndexedDB', 'Web Push API', 'fetch API', 'Sharp (thumbnails)'] },
    { title: 'INTEGRASI', items: ['Midtrans Snap (gateway)', 'Fonnte WA', 'Nodemailer SMTP', 'web-push (VAPID)', 'Redis (rate limit)', 'sharp (images)', 'pptxgenjs (decks)'] },
    { title: 'OPS', items: ['Cron / systemd timers', 'mysqldump backup', 'JobRun freshness', 'logrotate', '/api/health', '~370 tests (node:test)', 'PWA manifest + SW'] },
  ];

  const colW = 2.85; const gap = 0.2; const startX = 0.6; const startY = 2.4;
  categories.forEach((cat, i) => {
    const x = startX + i * (colW + gap);
    slide.addShape('rect', {
      x, y: startY, w: colW, h: 4.2,
      fill: { color: COLORS.ink900 },
      line: { color: COLORS.gold300, width: 1 },
    });
    slide.addText(cat.title, {
      x: x + 0.2, y: startY + 0.15, w: colW - 0.4, h: 0.4,
      fontFace: 'Consolas', fontSize: 11, color: COLORS.gold300, charSpacing: 4, bold: true,
    });
    slide.addText(cat.items.map((t) => ({
      text: t,
      options: { bullet: { type: 'bullet', code: '25CF', color: COLORS.gold300 } },
    })), {
      x: x + 0.2, y: startY + 0.65, w: colW - 0.4, h: 3.5,
      fontFace: 'Calibri', fontSize: 11, color: COLORS.cream100, lineSpacing: 18,
    });
  });
});

// 04 — Arsitektur high-level
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '03 · ARSITEKTUR');
  title(slide, 'Architecture overview');
  subtitle(slide, '4 portal · 1 backend · 1 database · cron jobs untuk maintenance');
  divider(slide);

  // ASCII-like diagram dengan kotak
  const tiers = [
    { y: 2.5, title: 'LAYER PRESENTASI · 4 portal', boxes: [
      { x: 0.6,  w: 2.9, label: 'PUBLIC\n/p/:slug', color: COLORS.sapphire },
      { x: 3.65, w: 2.9, label: 'JEMAAH (PWA)\n/saya', color: COLORS.emerald },
      { x: 6.7,  w: 2.9, label: 'AGEN\n/agen', color: COLORS.gold300 },
      { x: 9.75, w: 2.9, label: 'CREW (PWA)\n/crew + ADMIN /admin', color: COLORS.amber },
    ]},
    { y: 4.4, title: 'BACKEND · Express + Prisma', boxes: [
      { x: 0.6,  w: 4.0, label: 'Services\n(business logic)', color: COLORS.ink800 },
      { x: 4.75, w: 4.0, label: 'Notifikasi\nEmail · WA · Push', color: COLORS.ink800 },
      { x: 8.9,  w: 3.75, label: 'Audit Log\n(append-only)', color: COLORS.ink800 },
    ]},
    { y: 6.0, title: 'DATA · MySQL · Maintenance Jobs', boxes: [
      { x: 0.6,  w: 5.5, label: 'MySQL · Prisma migrations · indexes', color: COLORS.ruby },
      { x: 6.25, w: 6.4, label: 'Cron: expire-docs · expire-intents · send-notifs · prune · backup', color: COLORS.ruby },
    ]},
  ];

  tiers.forEach((tier) => {
    slide.addText(tier.title, {
      x: 0.6, y: tier.y - 0.3, w: W - 1.2, h: 0.25,
      fontFace: 'Consolas', fontSize: 9, color: COLORS.ink200, charSpacing: 3,
    });
    tier.boxes.forEach((b) => {
      slide.addShape('rect', {
        x: b.x, y: tier.y, w: b.w, h: 1.2,
        fill: { color: COLORS.ink900 },
        line: { color: b.color, width: 1.5 },
      });
      slide.addText(b.label, {
        x: b.x, y: tier.y, w: b.w, h: 1.2,
        fontFace: 'Consolas', fontSize: 11, color: COLORS.cream100,
        align: 'center', valign: 'middle', charSpacing: 1,
      });
    });
  });
});

// 05 — 8-role RBAC
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '04 · KEAMANAN');
  title(slide, 'RBAC 8 role · separation of duties');
  subtitle(slide, 'Setiap role punya scope yang ketat — uang masuk (kasir) ≠ uang keluar (manajer ops)');
  divider(slide);

  const roles = [
    { code: 'OWNER',       desc: 'Akses penuh + financial reports',     color: COLORS.gold300 },
    { code: 'SUPERADMIN',  desc: 'Akses penuh kecuali edit OWNER',      color: COLORS.gold300 },
    { code: 'MANAJER_OPS', desc: 'Cancel · refund · transfer · payout', color: COLORS.emerald },
    { code: 'KASIR',       desc: 'Record payment + walk-in booking (TIDAK refund / payout)', color: COLORS.sapphire },
    { code: 'SALES',       desc: 'Read-only — reporting only',          color: COLORS.ink200 },
    { code: 'AGEN',        desc: 'Lead CRM · Marketing kit · Komisi',   color: COLORS.amber },
    { code: 'MUTHAWWIF',   desc: 'Read-only manifest + attendance + SOS', color: COLORS.ruby },
    { code: 'JEMAAH',      desc: 'Self-service: profil · dokumen · bayar', color: COLORS.cream100 },
  ];

  const colW = 6.0; const startX = 0.6; const startY = 2.4; const rowH = 0.55;
  roles.forEach((r, i) => {
    const col = Math.floor(i / 4);
    const row = i % 4;
    const x = startX + col * (colW + 0.2);
    const y = startY + row * (rowH + 0.15);
    slide.addShape('rect', {
      x, y, w: colW, h: rowH,
      fill: { color: COLORS.ink900 },
      line: { color: r.color, width: 1 },
    });
    slide.addText(r.code, {
      x: x + 0.15, y, w: 1.6, h: rowH,
      fontFace: 'Consolas', fontSize: 12, color: r.color, valign: 'middle', charSpacing: 2, bold: true,
    });
    slide.addText(r.desc, {
      x: x + 1.85, y, w: colW - 2.0, h: rowH,
      fontFace: 'Calibri', fontSize: 12, color: COLORS.cream100, valign: 'middle',
    });
  });
});

// 06 — Public landing + booking
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '05 · FITUR · PUBLIC');
  title(slide, 'Landing /p/:slug — agent attribution');
  subtitle(slide, 'Halaman jualan paket dengan deep-link agen lock-in untuk attribution audit-able');
  divider(slide);

  bullet(slide, [
    'URL pattern /p/<paketSlug>?a=<agentSlug> — auto-link booking ke agen.',
    'agentSlugCap di-snapshot saat booking — tetap survive walaupun slug agen di-rename.',
    'Auto pre-fill nama + telepon untuk jemaah yang sudah login.',
    'Rate-limit 8/min/IP untuk public booking endpoint.',
    'BookingNo scheme RP-YYYY-NNNNN dengan retry-on-collision (5x).',
  ], { w: 6.4, h: 4.0 });

  addScreenshot(slide, '01-public-landing.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: 'screens/paket-detail.html — public sales page',
  });
});

// 07 — Jemaah portal /saya
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '06 · FITUR · JEMAAH');
  title(slide, 'Portal /saya — PWA installable');
  subtitle(slide, 'Self-service jemaah: lihat booking, bayar online, upload dokumen, kirim profil');
  divider(slide);

  bullet(slide, [
    'PWA installable di Android Chrome + iOS Safari (Share → Add to Home Screen + onboarding hint).',
    'Bottom-nav 4-tab: Beranda · Paket · Notifikasi · Profil.',
    'Bayar online via Midtrans Snap (VA · QRIS · Card · E-wallet).',
    'Upload paspor / visa / vaccine cert dengan auto-thumbnail (sharp 256px).',
    'Notifikasi inbox dengan unread badge (5rr).',
    'Voucher booking printable A4 (stage 20).',
    'Soft-merge: claim booking lama otomatis konsolidasi profil.',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '02-jemaah-portal.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: '/saya — jemaah dashboard (PWA-installable)',
  });
});

// 08 — Agen portal /agen
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '07 · FITUR · AGEN');
  title(slide, 'Portal /agen — CRM untuk agen reseller');
  subtitle(slide, 'Leads kanban · Marketing kit · Wallet · Analitik · 4 tab terintegrasi');
  divider(slide);

  bullet(slide, [
    'Pipeline kanban 4-kolom: Cold · Warm · Hot · LUNAS (campuran Lead + Booking).',
    'Marketing kit: link auto-generated /p/<slug>?a=<agentSlug> + copy-to-clipboard.',
    'Wallet & komisi: pending · earned · paid · cancelled + 20 payout terakhir.',
    'Analitik: funnel SVG 5-stage · sumber lead · sparkline 30-hari · per-paket leaderboard · komisi 6 bulan bar chart.',
    'Komisi rate dengan 4-tier precedence: AgentPaketKomisi → komisiRateOverride → Paket.komisiRate → DEFAULT.',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '03-agen-crm.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: '/agen — Leads pipeline kanban',
  });
});

// 09 — Crew portal /crew
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '08 · FITUR · CREW');
  title(slide, 'Portal /crew — muthawwif workspace');
  subtitle(slide, 'Read-only manifest · attendance offline-friendly · SOS dengan 3-channel fan-out');
  divider(slide);

  bullet(slide, [
    'Dashboard paket yang di-assign, manifest jemaah tanpa kolom uang (separation of duty).',
    'CSV export untuk offline reference (5ss) — UTF-8 BOM, RFC 4180.',
    'Attendance per-day grid dengan IndexedDB queue (5xx) — replay form submit saat online lagi.',
    'SOS button floating (ruby pulse) di setiap halaman /crew — modal 5 jenis incident.',
    'SOS fan-out 3 channel: EMAIL (queued) · WA (queued) · Web Push (real-time browser).',
    'Tidak ada akses ke money — KASIR & MANAJER_OPS yang handle.',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '04-crew-portal.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: '/crew — paket list + SOS button',
  });
});

// 10 — Admin dashboard
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '09 · FITUR · ADMIN');
  title(slide, 'Dashboard /admin — HQ control center');
  subtitle(slide, '5 tab + 10+ sub-page · semua data agen + jemaah + finance dalam satu pane');
  divider(slide);

  bullet(slide, [
    'Tab Overview: KPI · funnel · top paket · revenue trend per paket · komisi 6-bulan bar chart.',
    'Tab Paket / Manifest / Bunking / Finance.',
    'Sub-page: Users · Jemaah · Bookings (global search) · Audit · Notifikasi · Payment Intents · Incidents · Payouts · Calendar · Checklist.',
    'Per-paket profitability (stage 22): revenue − cost − komisi liability = net margin %.',
    'Print-friendly outputs: manifest (A4 landscape) · voucher per-jemaah · slip payout · pre-departure checklist.',
    'Calendar view bulanan (stage 24) untuk planning + drill per tanggal.',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '05-admin-overview.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: '/admin — overview tab dengan KPI + charts',
  });
});

// 11 — Money flow
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '10 · MONEY FLOW');
  title(slide, 'Payment → Komisi → Payout');
  subtitle(slide, 'Append-only Payment ledger + state machine forward-only');
  divider(slide);

  bullet(slide, [
    'recordPayment() = single source of truth — admin-recorded + gateway webhook lewat fungsi yang sama.',
    'State machine forward-only: PENDING → BOOKED → DP_PAID → PARTIAL → LUNAS (CANCELLED/REFUNDED terminal).',
    'Auto-Komisi pada LUNAS transition — idempotent, rate locked-in di Komisi.amount snapshot.',
    'Refund = negative-amount Payment row, append-only (tidak edit original).',
    'Payout bundles all EARNED komisi for one agent, transactional, payoutNo = PO-YYYY-NNNNN.',
    'Midtrans Snap webhook delegate ke recordPayment — single math path, idempotent on retry.',
  ]);
});

// 12 — Mobile experience
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '11 · MOBILE');
  title(slide, 'PWA · offline · push');
  subtitle(slide, 'Installable di HP, attendance queue di IndexedDB, SOS push real-time');
  divider(slide);

  bullet(slide, [
    'PWA shell: manifest.webmanifest · service worker · install prompt + iOS hint.',
    'Cache strategy: static cache-first, HTML network-first, offline.html fallback.',
    'Offline attendance: IndexedDB queue replay on online event + 20s tick (server upsert sudah idempotent).',
    'Web Push: VAPID + browser subscription — 3rd channel di samping email + WA.',
    'SOS: requireInteraction=true → toast nempel sampai admin klik.',
    'Mobile bottom-nav untuk jemaah, responsive @media baseline, tap-target ≥ 44px.',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '06-mobile-pwa.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: '/saya di mobile dengan bottom-nav + PWA install',
  });
});

// 13 — Print outputs
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '12 · PRINT OUTPUTS');
  title(slide, 'Print trifecta — paperwork lengkap');
  subtitle(slide, 'Manifest + Voucher + Slip = full accounting + ops trail');
  divider(slide);

  const cards = [
    { x: 0.6,  title: 'MANIFEST', desc: 'A4 landscape\nAirport check-in worksheet\nRoom-first sort\nPaspor + emergency contact', file: '07-print-manifest.png' },
    { x: 4.85, title: 'VOUCHER',  desc: 'A4 portrait per-jemaah\nIdentity + paket + payment\nItinerary condensed\nBackup for manasik handout', file: '08-print-voucher.png' },
    { x: 9.1,  title: 'SLIP PAYOUT', desc: 'A4 portrait per-payout\nAgen identity + komisi table\n2 signature boxes\nUntuk accounting record', file: '09-print-slip.png' },
  ];
  cards.forEach((c) => {
    slide.addShape('rect', {
      x: c.x, y: 2.4, w: 3.85, h: 4.2,
      fill: { color: COLORS.ink900 },
      line: { color: COLORS.gold300, width: 1 },
    });
    slide.addText(c.title, {
      x: c.x + 0.2, y: 2.55, w: 3.45, h: 0.35,
      fontFace: 'Consolas', fontSize: 12, color: COLORS.gold300, charSpacing: 4, bold: true,
    });
    slide.addText(c.desc, {
      x: c.x + 0.2, y: 2.95, w: 3.45, h: 1.4,
      fontFace: 'Calibri', fontSize: 13, color: COLORS.cream100, lineSpacing: 20,
    });
    addScreenshot(slide, c.file, {
      x: c.x + 0.3, y: 4.5, w: 3.25, h: 1.9, caption: null,
    });
  });
});

// 14 — Analytics & BI
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '13 · ANALYTICS');
  title(slide, 'BI tooling — siapa untung, paket mana yang konversi');
  subtitle(slide, 'Funnel · leaderboard · monthly trend · net margin · checklist · calendar');
  divider(slide);

  bullet(slide, [
    'Per-paket leaderboard dengan revenue + cost + komisi liability + NET MARGIN%.',
    'Margin color tier: ≥20% emerald · ≥5% gold · ≥0% amber · negative ruby — losses tidak di-mask.',
    'Komisi monthly bar chart 6-bulan: earned (amber) vs paid (emerald).',
    'Pre-departure checklist 8-poin per jemaah (paspor 6-bulan rule + 4 verified docs + room + emergency).',
    'Calendar bulanan untuk planning + drill per tanggal.',
    'Sumber lead breakdown + funnel agen + sparkline 30-hari (semua agen / per agen).',
  ], { w: 6.4, h: 4.5 });

  addScreenshot(slide, '10-leaderboard.png', {
    x: 7.3, y: 2.4, w: 5.4, h: 3.8,
    caption: 'Leaderboard paket dengan net margin',
  });
});

// 15 — Notif & Push system
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '14 · NOTIFIKASI');
  title(slide, 'Multi-channel queue · retry · opt-out');
  subtitle(slide, 'Email · WA · Web Push dengan template engine + retry backoff + audit trail');
  divider(slide);

  bullet(slide, [
    'Notification model = durable queue + dispatch log. PENDING → SENT / FAILED / SKIPPED.',
    'Senders: console (default) · Fonnte WA · SMTP (nodemailer) · web-push.',
    'Templates JSON-based dengan {{var}} placeholders — easy localise per type × channel.',
    'Retry exponential backoff (5nn): 1m · 5m · 30m · 2h · 12h sebelum terminal.',
    'Per-channel opt-out di JemaahProfile.notifEmail/notifWa + per-type di JemaahNotifPref.',
    'In-process worker (30s) + cron HTTP trigger — NOTIF_WORKER_DISABLED=true di production.',
    'Jemaah inbox /saya/notifications dengan unread badge (5rr) auto-clear setelah view.',
  ]);
});

// 16 — Operasional / production-ready
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '15 · PRODUCTION READINESS');
  title(slide, 'Sudah siap untuk go-live');
  subtitle(slide, 'Security · observability · backup · retention · launch readiness drill');
  divider(slide);

  bullet(slide, [
    'Boot-time env validation: production fail-fast kalau JWT_SECRET / COOKIE_SECURE / dll. tidak set.',
    'CSRF protection double-submit cookie + Redis-backed rate-limit (multi-instance safe).',
    'Audit log permanen (append-only) untuk setiap state change. Read-only viewer untuk admin.',
    'Weekly retention job (prune): bound Notification/JobRun/failed-intent growth. AuditLog + Payment NEVER pruned.',
    '/api/health dengan per-job freshness — eksternal uptime monitor cukup alert pada single field.',
    'Nightly mysqldump --single-transaction + 14-day rotation. Production deploy guide lengkap di deploy/.',
    'Pre-launch smoke runner (scripts/smoke-launch.js) — health + CSRF mint + sensitive-path block + bogus-creds.',
  ]);
});

// 17 — Test suite
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '16 · QUALITY');
  title(slide, 'Test suite ~370 tests · node:test built-in');
  subtitle(slide, 'Zero-dependency test runner · serialized · DB fixture-based');
  divider(slide);

  const stats = [
    { label: 'Total tests', value: '362' },
    { label: 'Test suites', value: '127' },
    { label: 'Smoke scripts', value: '20+' },
    { label: 'Coverage', value: 'service + route' },
  ];
  const cw = 2.85; const start = 0.6;
  stats.forEach((s, i) => {
    const x = start + i * (cw + 0.2);
    slide.addShape('rect', {
      x, y: 2.4, w: cw, h: 1.8,
      fill: { color: COLORS.ink900 },
      line: { color: COLORS.gold300, width: 1 },
    });
    slide.addText(s.label, {
      x: x + 0.2, y: 2.55, w: cw - 0.4, h: 0.4,
      fontFace: 'Consolas', fontSize: 10, color: COLORS.ink200, charSpacing: 3,
    });
    slide.addText(s.value, {
      x: x + 0.2, y: 2.95, w: cw - 0.4, h: 1.1,
      fontFace: 'Georgia', fontSize: 36, color: COLORS.gold300, valign: 'middle',
    });
  });

  bullet(slide, [
    'node:test built-in (Node ≥ 18) — zero install, --test-concurrency=1 untuk DB isolation.',
    'Tag-prefixed fixtures (makeTag) — tests share dev DB tapi isolated lewat tag prefix.',
    'Smoke scripts berdampingan: pre-launch · payment gateway · offline attendance · web push.',
    'Full suite 362/362 pass — green sebelum setiap commit.',
  ], { w: W - 1.2, y: 4.5, h: 2.5 });
});

// 18 — Stages
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '17 · TIMELINE');
  title(slide, '24 stages dijalankan secara terstruktur');
  subtitle(slide, 'Build-out staged — setiap stage didokumentasi di CLAUDE.md');
  divider(slide);

  const stages = [
    '01-02  Skeleton + Prisma + MySQL seed',
    '03     Auth + RBAC (8 role)',
    '04     Public landing + booking',
    '05     Agen portal CRM',
    '06     Admin dashboard',
    '07     Money flow + komisi',
    '08     Ops jobs (cron)',
    '09     Jemaah portal',
    '10     Notifikasi (queue + retry)',
    '11     Payment gateway (Midtrans)',
    '12     Crew portal',
    '13     Mobile experience (PWA + offline)',
    '14     Per-paket × per-agen komisi matrix',
    '15     Document thumbnails',
    '16     Analytics extension',
    '17     Web Push SOS',
    '18     Paket clone',
    '19     Print manifest',
    '20     Per-jemaah voucher',
    '21     Payout slip',
    '22     Per-paket profitability',
    '23     Pre-departure checklist',
    '24     Departure calendar',
  ];

  const colW = 6.0; const colItems = Math.ceil(stages.length / 2);
  for (let col = 0; col < 2; col++) {
    const x = 0.6 + col * (colW + 0.3);
    const slice = stages.slice(col * colItems, (col + 1) * colItems);
    slide.addText(slice.map((t) => ({
      text: t,
      options: { bullet: { type: 'bullet', code: '25AA', color: COLORS.gold300 } },
    })), {
      x, y: 2.4, w: colW, h: 4.5,
      fontFace: 'Consolas', fontSize: 11, color: COLORS.cream100, lineSpacing: 20,
    });
  }
});

// 19 — Kelebihan
SLIDES.push((slide) => {
  darkBg(slide);
  eyebrow(slide, '18 · KELEBIHAN');
  title(slide, 'Mengapa Religio Pro');
  subtitle(slide, '8 alasan kuat dibanding solusi spreadsheet, WhatsApp group, atau platform generic');
  divider(slide);

  const advantages = [
    { title: 'TERINTEGRASI',       desc: 'Lead → Booking → Payment → Komisi → Payout otomatis. Tidak ada double-entry, tidak ada lupa.' },
    { title: 'BHS. INDONESIA',     desc: 'Seluruh UI dalam Bahasa Indonesia. Owner, kasir, agen, jemaah semua nyaman tanpa training translasi.' },
    { title: 'SEPARATION OF DUTIES', desc: '8-role RBAC mencegah kasir menulis-off refund, mencegah agen lihat data agen lain.' },
    { title: 'OFFLINE-FRIENDLY',   desc: 'PWA + IndexedDB. Attendance + SOS jalan di bus tanpa sinyal — sync saat online.' },
    { title: 'AUDIT TRAIL',        desc: 'Setiap state change ditulis ke AuditLog (append-only). Investigasi cepat, compliance ready.' },
    { title: 'PRINT-READY',        desc: 'Manifest · voucher · slip payout siap cetak A4 — tidak perlu Excel/Word manual.' },
    { title: 'OWNER BI',           desc: 'Profitability per paket, komisi trend, leaderboard cross-agen — owner tahu paket mana yang untung.' },
    { title: 'PRODUCTION-READY',   desc: 'Rate limit · CSRF · backup · retention · health check · ~370 tests. Bukan prototype.' },
  ];
  const cw = 6.0; const rh = 1.0; const startX = 0.6; const startY = 2.4;
  advantages.forEach((a, i) => {
    const col = Math.floor(i / 4);
    const row = i % 4;
    const x = startX + col * (cw + 0.3);
    const y = startY + row * (rh + 0.1);
    slide.addShape('rect', {
      x, y, w: cw, h: rh,
      fill: { color: COLORS.ink900 },
      line: { color: COLORS.gold300, width: 1 },
    });
    slide.addText(a.title, {
      x: x + 0.2, y: y + 0.1, w: cw - 0.4, h: 0.3,
      fontFace: 'Consolas', fontSize: 11, color: COLORS.gold300, charSpacing: 3, bold: true,
    });
    slide.addText(a.desc, {
      x: x + 0.2, y: y + 0.4, w: cw - 0.4, h: 0.55,
      fontFace: 'Calibri', fontSize: 11, color: COLORS.cream100, lineSpacing: 16,
    });
  });
});

// 20 — Closing
SLIDES.push((slide) => {
  darkBg(slide);
  // gold accent
  slide.addShape('rect', {
    x: 0.6, y: 2.0, w: 1.8, h: 0.04,
    fill: { color: COLORS.gold300 }, line: { type: 'none' },
  });
  slide.addText([
    { text: 'Terima ', options: { color: COLORS.cream100 } },
    { text: 'kasih', options: { color: COLORS.gold300, italic: true } },
  ], {
    x: 0.6, y: 2.3, w: W - 1.2, h: 1.5,
    fontFace: 'Georgia', fontSize: 70,
  });
  slide.addText('Ready to demo, ready to deploy', {
    x: 0.6, y: 4.0, w: W - 1.2, h: 0.4,
    fontFace: 'Consolas', fontSize: 14, color: COLORS.gold200, charSpacing: 3,
  });

  // Demo URL grid
  const demos = [
    'Public landing  ·  /p/ramadhan-aqsa-2026',
    'Jemaah portal   ·  /saya',
    'Agen CRM        ·  /agen',
    'Crew workspace  ·  /crew',
    'Admin HQ        ·  /admin',
    'API health      ·  /api/health',
  ];
  slide.addText(demos.map((t) => ({
    text: t,
    options: { bullet: { type: 'bullet', code: '25B6', color: COLORS.gold300 } },
  })), {
    x: 0.6, y: 5.0, w: W - 1.2, h: 2.0,
    fontFace: 'Consolas', fontSize: 13, color: COLORS.cream100, lineSpacing: 22, charSpacing: 1,
  });
});

// ── Generate ─────────────────────────────────────────────────
const total = SLIDES.length;
SLIDES.forEach((build, i) => {
  const slide = pres.addSlide();
  build(slide);
  if (i > 0 && i < total - 1) pageFooter(slide, i + 1, total);
});

const outFile = path.join(OUT_DIR, 'religio-pro.pptx');
await pres.writeFile({ fileName: outFile });
console.log(`✓ ${outFile} (${total} slides)`);
console.log(`  Drop screenshots into presentation/screenshots/ matching filenames in`);
console.log(`  presentation/SCREENSHOT-GUIDE.md, then re-run this script to embed.`);
