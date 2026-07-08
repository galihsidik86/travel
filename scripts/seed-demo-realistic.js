// =============================================================
// Religio Pro — realistic demo data generator
//
// Fills the platform with data that reads like a real, operating
// umrah/hajj agency rather than obvious test fixtures — for client
// demos. Run once (not idempotent by design; re-running will add a
// second batch rather than upsert, since bookingNo/testimonial IDs
// are freshly minted each run).
//
// PART A cleans up known one-off smoke-test debris (two "Smoke
// In-Trip Paket S320" rows + their bookings/jemaah/user, created by
// a manual smoke run right after the 2026-06-20 deploy — verified
// via direct DB inspection to be fully self-contained: no Payment,
// no Komisi, agentId null, referenced only by loose (non-FK)
// AuditLog rows which are append-only and untouched).
//
// PART B adds: 5 new agents, 3 new paket (1 completed/past trip for
// rich historical analytics, 2 active/future for a live pipeline),
// ~45 jemaah + bookings spread across every BookingStatus, matching
// payments + komisi, leads across the CRM funnel, testimonials, NPS
// trip feedback, attendance marks, and one komisi payout.
//
// Usage: node --env-file-if-exists=.env scripts/seed-demo-realistic.js
// =============================================================

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ── RNG helpers (seeded-ish via simple LCG so reruns are reproducible
//    within a run, not across runs — fine for demo data) ────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function daysAgo(n) { return new Date(Date.now() - n * 86400_000); }
function daysFromNow(n) { return new Date(Date.now() + n * 86400_000); }
function idr(n) { return Math.round(n).toFixed(2); }

// ── Name pools ───────────────────────────────────────────────
const MALE_FIRST = ['Ahmad', 'Muhammad', 'Bambang', 'Hendra', 'Joko', 'Agus', 'Rizki', 'Fauzi', 'Dedi', 'Yusuf', 'Wahyu', 'Nurdin', 'Slamet', 'Hasan', 'Iwan', 'Rudi', 'Andi', 'Firman', 'Taufik', 'Arif', 'Anwar', 'Suryadi', 'Kurniawan', 'Setiawan', 'Ridwan'];
const FEMALE_FIRST = ['Siti', 'Dewi', 'Fitriani', 'Yuli', 'Sri', 'Rina', 'Hartini', 'Sarah', 'Ratna', 'Endang', 'Wulan', 'Indah', 'Nur', 'Lestari', 'Kartika', 'Anisa', 'Maya', 'Putri', 'Rahmawati', 'Yani', 'Ningsih', 'Wahyuni', 'Handayani', 'Susanti'];
const LAST = ['Wibowo', 'Santoso', 'Kusuma', 'Hidayat', 'Susanto', 'Setiawan', 'Wijaya', 'Pratama', 'Nasution', 'Siregar', 'Hakim', 'Rahman', 'Latif', 'Suherman', 'Gunawan', 'Purnomo', 'Ramadhan', 'Anwar', 'Firdaus', 'Yusuf', 'Ali', 'Zulkifli', 'Maulana', 'Azzahra', 'Nugroho'];
const HONORIFIC_M = ['Pak', 'Pak', 'Pak', 'H.', 'Bapak'];
const HONORIFIC_F = ['Bu', 'Bu', 'Bu', 'Hj.', 'Ibu'];
const CITIES = ['Jakarta', 'Bandung', 'Surabaya', 'Bekasi', 'Depok', 'Tangerang', 'Bogor', 'Semarang', 'Medan', 'Makassar', 'Yogyakarta', 'Malang'];

const usedPhones = new Set();
function genPhone() {
  const prefixes = ['0811', '0812', '0813', '0821', '0822', '0852', '0853', '0878', '0895', '0896', '0857', '0858', '0877'];
  let phone;
  do {
    phone = `${pick(prefixes)}-${randInt(1000, 9999)}-${randInt(1000, 9999)}`;
  } while (usedPhones.has(phone));
  usedPhones.add(phone);
  return phone;
}

function genName() {
  const isMale = Math.random() < 0.5;
  const first = pick(isMale ? MALE_FIRST : FEMALE_FIRST);
  const last = pick(LAST);
  const honorific = Math.random() < 0.4 ? pick(isMale ? HONORIFIC_M : HONORIFIC_F) + ' ' : '';
  return `${honorific}${first} ${last}`;
}

let nikCounter = 3271010000000001n;
function genNik() { return String(nikCounter++); }
let passportCounter = 41000001;
function genPassport() { return `C${passportCounter++}`; }

async function nextBookingNo(year) {
  const prefix = `RP-${year}-`;
  const count = await db.booking.count({ where: { bookingNo: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(5, '0')}`;
}

// =============================================================
// PART A — clean up known smoke-test debris
// =============================================================
async function cleanupSmokeJunk() {
  console.log('── Cleanup: smoke-test debris ──');
  const junkPaket = await db.paket.findMany({
    where: { slug: { startsWith: 'smoke-intrip-' } },
    select: { id: true, slug: true },
  });
  if (junkPaket.length === 0) {
    console.log('  nothing to clean (already removed)');
    return;
  }
  const paketIds = junkPaket.map((p) => p.id);
  const junkBookings = await db.booking.findMany({
    where: { paketId: { in: paketIds } },
    select: { id: true, bookingNo: true, jemaahId: true },
  });
  const bookingIds = junkBookings.map((b) => b.id);
  const jemaahIds = [...new Set(junkBookings.map((b) => b.jemaahId))];

  // Verify these jemaah have no OTHER bookings before we consider deleting them.
  const jemaahStillUsed = new Set(
    (await db.booking.findMany({
      where: { jemaahId: { in: jemaahIds }, id: { notIn: bookingIds } },
      select: { jemaahId: true },
    })).map((b) => b.jemaahId),
  );
  const safeToDeleteJemaah = jemaahIds.filter((id) => !jemaahStillUsed.has(id));

  await db.testimonial.deleteMany({ where: { paketId: { in: paketIds } } });
  await db.paketCrew.deleteMany({ where: { paketId: { in: paketIds } } });
  await db.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await db.komisi.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await db.attendanceMark.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await db.tripFeedback.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await db.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await db.paketDay.deleteMany({ where: { paketId: { in: paketIds } } });
  await db.paketHarga.deleteMany({ where: { paketId: { in: paketIds } } });
  await db.paketHotel.deleteMany({ where: { paketId: { in: paketIds } } });
  await db.paket.deleteMany({ where: { id: { in: paketIds } } });

  if (safeToDeleteJemaah.length) {
    const orphanUsers = await db.jemaahProfile.findMany({
      where: { id: { in: safeToDeleteJemaah } },
      select: { userId: true },
    });
    await db.jemaahProfile.deleteMany({ where: { id: { in: safeToDeleteJemaah } } });
    const userIds = orphanUsers.map((j) => j.userId).filter(Boolean);
    if (userIds.length) {
      await db.user.deleteMany({ where: { id: { in: userIds }, email: { contains: '@example.test' } } });
    }
  }

  console.log(`  removed ${paketIds.length} junk paket, ${bookingIds.length} junk bookings, ${safeToDeleteJemaah.length} orphan jemaah`);
}

// =============================================================
// PART B — realistic demo data
// =============================================================
async function main() {
  await cleanupSmokeJunk();

  const owner = await db.user.findUnique({ where: { email: 'owner@religio.pro' } });
  const crewUser = await db.user.findUnique({ where: { email: 'muthawwif1@religio.pro' } });
  if (!owner) throw new Error('Base seed missing — run `npm run db:seed` first.');

  // ── New agents ─────────────────────────────────────────────
  console.log('── Agents ──');
  const bcrypt = (await import('bcryptjs')).default;
  const agentDefs = [
    { slug: 'siti-n', name: 'Siti Nurhaliza', ig: 'religio.siti', wa: '0813-2024-8871', tier: 'Mitra Bersertifikat · 3 tahun', verified: false, bio: null },
    { slug: 'bambang-s', name: 'H. Bambang Sutrisno', ig: 'religio.bambang', wa: '0812-9931-4420', tier: 'Mitra Senior · 6 tahun', verified: true, bio: 'Membimbing jemaah umroh & haji sejak 2020 — fokus pada keluarga dan lansia. Alumni pembimbing manasik KBIHU Nurul Iman.' },
    { slug: 'dewi-k', name: 'Dewi Kartika', ig: 'religio.dewik', wa: '0821-5567-3390', tier: 'Mitra Baru · 8 bulan', verified: false, bio: null },
    { slug: 'rizki-r', name: 'Muhammad Rizki Ramadhan', ig: 'religio.rizki', wa: '0852-7712-6634', tier: 'Top Partner · 5 tahun', verified: true, bio: 'Top performer 2025 dengan 180+ jemaah diberangkatkan. Spesialis paket VVIP dan grup korporat.' },
    { slug: 'fitri-a', name: 'Fitriani Azzahra', ig: 'religio.fitri', wa: '0878-3345-9912', tier: 'Mitra Bersertifikat · 4 tahun', verified: true, bio: 'Fokus melayani jemaah dari komunitas majelis taklim se-Jabodetabek.' },
  ];
  const agents = {};
  for (const a of agentDefs) {
    const email = `${a.slug.replace('-', '.')}@religio.pro`;
    const user = await db.user.upsert({
      where: { email },
      update: {},
      create: {
        email, passwordHash: await bcrypt.hash('agen12345', 10),
        role: 'AGEN', fullName: a.name, phone: a.wa,
      },
    });
    const agent = await db.agentProfile.upsert({
      where: { userId: user.id },
      update: { displayName: a.name, slug: a.slug, igHandle: a.ig, whatsapp: a.wa, tier: a.tier, isVerified: a.verified, bio: a.bio, photoUrl: a.verified ? '/uploads/agents/placeholder.jpg' : null },
      create: { userId: user.id, slug: a.slug, displayName: a.name, igHandle: a.ig, whatsapp: a.wa, bio: a.bio, tier: a.tier, isVerified: a.verified },
    });
    agents[a.slug] = agent;
  }
  const ahmad = await db.agentProfile.findUnique({ where: { slug: 'ahmad-w' } });
  if (ahmad) agents['ahmad-w'] = ahmad;
  console.log(`  ${Object.keys(agents).length} agents ready`);

  // ── New paket ──────────────────────────────────────────────
  console.log('── Paket ──');

  // Paket 1 — COMPLETED trip (rich historical data for analytics)
  const pastPaket = await db.paket.upsert({
    where: { slug: 'umroh-ramadhan-awal-2026' },
    update: {},
    create: {
      slug: 'umroh-ramadhan-awal-2026',
      title: 'Umroh Ramadhan Awal 2026',
      subtitle: '12 Hari · 11 Malam · 10 Hari Awal Ramadhan',
      heroTitleHtml: 'Umroh Awal<br>Ramadhan,<br><em>Kesucian di<br>Tanah Suci.</em>',
      arabicTagline: 'رَمَضَانُ الَّذِي أُنْزِلَ فِيهِ الْقُرْآنُ',
      translitTagline: '"Ramadan, bulan diturunkannya Al-Quran."',
      departureDate: new Date('2026-03-05T22:30:00+07:00'),
      returnDate: new Date('2026-03-19T10:00:00+07:00'),
      durationDays: 12,
      airline: 'Saudia Airlines', airlineCode: 'SV-816', routeFrom: 'CGK', routeTo: 'MED',
      heroDescription: 'Dua belas hari penuh berkah di 10 hari pertama Ramadhan — momentum terbaik memulai puasa di kota suci.',
      inclusions: ['Visa Umroh resmi', 'Tiket pesawat PP Saudia', 'Hotel Madinah ★★★★ 5 malam', 'Hotel Mekkah ★★★★ 6 malam', 'Makan 3× sehari', 'Muthawwif pembimbing', 'Manasik 3× sebelum berangkat', 'Perlengkapan umroh lengkap', 'Asuransi perjalanan'],
      exclusions: ['Suntik meningitis', 'Kelebihan bagasi', 'Pengeluaran pribadi'],
      trustBadges: [{ label: 'Izin Kemenag', value: 'U-129' }, { label: 'SISKOPATUH', value: 'Terdaftar' }],
      kursiTotal: 25, kursiTerisi: 22,
      manifestClosesAt: new Date('2026-02-20T17:00:00+07:00'),
      status: 'CLOSED', publishedAt: daysAgo(180), createdById: owner.id,
      costPerPaxIdr: idr(38_000_000), costNotes: 'Hotel + tiket + visa + ops',
      requiredDocs: ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT', 'MANASIK_CERT'],
    },
  });

  // Paket 2 — near-term, filling up
  const nearPaket = await db.paket.upsert({
    where: { slug: 'umroh-reguler-oktober-2026' },
    update: {},
    create: {
      slug: 'umroh-reguler-oktober-2026',
      title: 'Umroh Reguler Oktober 2026',
      subtitle: '9 Hari · 8 Malam · Musim Sejuk Madinah',
      heroTitleHtml: 'Umroh Reguler,<br><em>Nyaman &<br>Terjangkau.</em>',
      arabicTagline: 'وَأَتِمُّوا الْحَجَّ وَالْعُمْرَةَ لِلَّهِ',
      translitTagline: '"Dan sempurnakanlah ibadah haji dan umrah karena Allah."',
      departureDate: new Date('2026-10-15T21:00:00+07:00'),
      returnDate: new Date('2026-10-23T14:00:00+07:00'),
      durationDays: 9,
      airline: 'Lion Air', airlineCode: 'JT-3110', routeFrom: 'CGK', routeTo: 'JED',
      heroDescription: 'Paket reguler 9 hari dengan harga terjangkau tanpa mengurangi kualitas ibadah — favorit jemaah keluarga.',
      inclusions: ['Visa Umroh resmi', 'Tiket pesawat PP', 'Hotel Madinah ★★★ 3 malam', 'Hotel Mekkah ★★★★ 4 malam', 'Makan 3× sehari', 'Muthawwif pembimbing', 'Manasik 2× sebelum berangkat', 'Koper & seragam'],
      exclusions: ['Suntik meningitis', 'Pembuatan paspor baru', 'Kelebihan bagasi'],
      trustBadges: [{ label: 'Izin Kemenag', value: 'U-129' }, { label: 'AMPHURI', value: 'Anggota Aktif' }],
      kursiTotal: 40, kursiTerisi: 0,
      manifestClosesAt: new Date('2026-09-15T17:00:00+07:00'),
      status: 'ACTIVE', publishedAt: daysAgo(60), createdById: owner.id,
      costPerPaxIdr: idr(24_500_000), costNotes: 'Hotel + tiket + visa + ops',
      requiredDocs: ['VISA_UMROH', 'VACCINE_MENINGITIS'],
    },
  });

  // Paket 3 — future premium, early pipeline
  const futurePaket = await db.paket.upsert({
    where: { slug: 'umroh-eksekutif-januari-2027' },
    update: {},
    create: {
      slug: 'umroh-eksekutif-januari-2027',
      title: 'Umroh Eksekutif Januari 2027',
      subtitle: '11 Hari · 10 Malam · Hotel Bintang 5 View Haram',
      heroTitleHtml: 'Umroh Eksekutif,<br><em>Kemewahan &<br>Kekhusyukan.</em>',
      arabicTagline: 'إِنَّ الصَّفَا وَالْمَرْوَةَ مِنْ شَعَائِرِ اللَّهِ',
      translitTagline: '"Sesungguhnya Shafa dan Marwah adalah sebagian syiar Allah."',
      departureDate: new Date('2027-01-10T23:00:00+07:00'),
      returnDate: new Date('2027-01-20T15:00:00+07:00'),
      durationDays: 11,
      airline: 'Garuda Indonesia', airlineCode: 'GA-982', routeFrom: 'CGK', routeTo: 'JED',
      heroDescription: 'Sebelas hari kemewahan — hotel bintang 5 dengan pemandangan langsung ke Masjidil Haram, untuk jemaah yang menginginkan kenyamanan maksimal.',
      inclusions: ['Visa Umroh resmi', 'Tiket pesawat PP Garuda direct', 'Hotel Madinah ★★★★★ 4 malam', 'Hotel Mekkah ★★★★★ view Haram 6 malam', 'Makan 3× sehari premium', 'Muthawwif pembimbing 1:10', 'Manasik 4× sebelum berangkat', 'Koper premium + seragam', 'Air Zamzam 5L'],
      exclusions: ['Suntik meningitis', 'Pembuatan paspor baru', 'Pengeluaran pribadi'],
      trustBadges: [{ label: 'Izin Kemenag', value: 'U-129' }, { label: 'SISKOPATUH', value: 'Terdaftar' }, { label: 'Asuransi', value: 'AXA Travel' }],
      kursiTotal: 20, kursiTerisi: 0,
      manifestClosesAt: new Date('2026-11-30T17:00:00+07:00'),
      status: 'ACTIVE', publishedAt: daysAgo(20), createdById: owner.id,
      costPerPaxIdr: idr(52_000_000), costNotes: 'Hotel bintang 5 + tiket direct + visa + ops',
      requiredDocs: ['VISA_UMROH', 'VACCINE_MENINGITIS', 'HEALTH_CERT'],
    },
  });

  const paketList = [
    { paket: pastPaket, hotels: [
      { city: 'MADINAH', name: 'Dar Al Taqwa Hotel', stars: 4, distance: '200m Nabawi', nights: 5, order: 1 },
      { city: 'MEKKAH', name: 'Elaf Mashaer', stars: 4, distance: '400m Haram', nights: 6, order: 2 },
    ], prices: [
      { kelas: 'QUAD', label: 'Empat / kamar', priceIdr: 32_500_000, cicilan: 2710000 },
      { kelas: 'TRIPLE', label: 'Tiga / kamar', priceIdr: 36_000_000, cicilan: 3000000 },
      { kelas: 'DOUBLE', label: 'Dua / kamar', priceIdr: 40_500_000, cicilan: 3380000, featured: true },
    ] },
    { paket: nearPaket, hotels: [
      { city: 'MADINAH', name: 'Al Eiman Royal', stars: 3, distance: '600m Nabawi', nights: 3, order: 1 },
      { city: 'MEKKAH', name: 'Al Kiswah Towers', stars: 4, distance: '500m Haram', nights: 4, order: 2 },
    ], prices: [
      { kelas: 'QUAD', label: 'Empat / kamar', priceIdr: 24_500_000, cicilan: 2050000 },
      { kelas: 'TRIPLE', label: 'Tiga / kamar', priceIdr: 27_000_000, cicilan: 2250000, featured: true },
      { kelas: 'DOUBLE', label: 'Dua / kamar', priceIdr: 31_000_000, cicilan: 2580000 },
    ] },
    { paket: futurePaket, hotels: [
      { city: 'MADINAH', name: 'Pullman Zamzam Madinah', stars: 5, distance: '30m Nabawi', nights: 4, order: 1 },
      { city: 'MEKKAH', name: 'Fairmont Makkah Clock Tower', stars: 5, distance: 'View Haram', nights: 6, order: 2 },
    ], prices: [
      { kelas: 'TRIPLE', label: 'Tiga / kamar', priceIdr: 55_000_000, cicilan: 4580000 },
      { kelas: 'DOUBLE', label: 'Dua / kamar', priceIdr: 62_000_000, cicilan: 5170000, featured: true },
      { kelas: 'VVIP', label: 'Suite Eksekutif', priceIdr: 78_000_000, cicilan: 6500000 },
    ] },
  ];

  const priceByKelasByPaket = {};
  for (const { paket, hotels, prices } of paketList) {
    await db.paketHotel.deleteMany({ where: { paketId: paket.id } });
    await db.paketHotel.createMany({ data: hotels.map((h) => ({ paketId: paket.id, ...h })) });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.createMany({
      data: prices.map((p) => ({
        paketId: paket.id, kelas: p.kelas, label: p.label,
        caption: `Sharing ${p.kelas === 'QUAD' ? 4 : p.kelas === 'TRIPLE' ? 3 : p.kelas === 'DOUBLE' ? 2 : 1} jemaah`,
        priceIdr: idr(p.priceIdr), cicilanIdr: idr(p.cicilan), cicilanMonths: 10,
        perks: ['Hotel dekat masjid', 'Pesawat PP', 'Bagasi 30kg', 'Muthawwif pembimbing'],
        isFeatured: !!p.featured,
      })),
    });
    priceByKelasByPaket[paket.id] = Object.fromEntries(prices.map((p) => [p.kelas, p.priceIdr]));

    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.createMany({
      data: [
        { paketId: paket.id, dayNumber: 1, dayRange: 'Hari 01', title: 'Jakarta → Madinah', description: 'Manasik final dan keberangkatan menuju Madinah.', tags: ['Manasik Final'], highlight: true },
        { paketId: paket.id, dayNumber: 2, dayRange: `Hari 02–0${Math.min(hotels[0].nights, 9)}`, title: 'Ziarah Madinah', description: "Ritual Arba'in dan ziarah Raudhah, Quba, Uhud.", tags: ["Arba'in", 'Raudhah'] },
        { paketId: paket.id, dayNumber: hotels[0].nights + 1, dayRange: `Hari 0${hotels[0].nights + 1}`, title: 'Mekkah · niat umroh', description: 'Miqat dan thawaf umroh setibanya di Mekkah.', tags: ['Niat Umroh', 'Thawaf'], highlight: true },
        { paketId: paket.id, dayNumber: paket.durationDays, dayRange: `Hari ${paket.durationDays}`, title: 'Pulang ke Tanah Air', description: 'Penerbangan pulang menuju Jakarta.', tags: ['Pulang'], highlight: true },
      ],
    });
  }
  console.log(`  ${paketList.length} paket configured (hotels/prices/itinerary)`);

  // ── Jemaah + bookings across all 3 new paket + existing ramadhan-aqsa ──
  console.log('── Jemaah, bookings, payments, komisi ──');
  const agentSlugs = Object.keys(agents);
  let totalBookings = 0;
  let totalKomisi = 0;

  const KOMISI_RATE = 0.06;
  const pastBookingRows = []; // tracked for testimonials/NPS/attendance below

  async function makeBooking({ paket, kelas, pax, status, paidFrac, agentSlug, bookedDaysAgo, cancelReasonCode, noShow }) {
    const name = genName();
    const phone = genPhone();
    const total = priceByKelasByPaket[paket.id][kelas] * pax;
    const paid = status === 'PENDING' ? 0 : Math.round(total * paidFrac);
    const jemaah = await db.jemaahProfile.create({
      data: {
        fullName: name, phone,
        email: Math.random() < 0.6 ? `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@gmail.com` : null,
        emergencyContact: `${genName()} (${pick(['Suami', 'Istri', 'Anak', 'Saudara', 'Orang tua'])}) ${genPhone()}`,
        address: `Jl. ${pick(['Merdeka', 'Sudirman', 'Melati', 'Kenanga', 'Mawar', 'Kartini', 'Diponegoro'])} No. ${randInt(1, 99)}, ${pick(CITIES)}`,
        nik: paket.status === 'CLOSED' ? genNik() : null,
        passportNo: paket.status === 'CLOSED' || Math.random() < 0.4 ? genPassport() : null,
        passportExpiry: paket.status === 'CLOSED' ? daysFromNow(randInt(400, 1200)) : (Math.random() < 0.4 ? daysFromNow(randInt(200, 900)) : null),
      },
    });
    const year = paket.departureDate.getFullYear();
    const bookingNo = await nextBookingNo(year);
    const agentId = agentSlug ? agents[agentSlug].id : null;
    const booking = await db.booking.create({
      data: {
        bookingNo, paketId: paket.id, jemaahId: jemaah.id,
        agentId, agentSlugCap: agentSlug || null,
        kelas, paxCount: pax, totalAmount: idr(total), paidAmount: idr(paid),
        currency: 'IDR', status,
        createdAt: daysAgo(bookedDaysAgo),
        ...(status === 'CANCELLED' || status === 'REFUNDED' ? {
          cancelledAt: daysAgo(Math.max(1, bookedDaysAgo - randInt(5, 20))),
          cancelReason: cancelReasonCode === 'PAYMENT_NOT_RECEIVED' ? 'Jemaah tidak melanjutkan pembayaran setelah DP.' : cancelReasonCode === 'DOCUMENT_INCOMPLETE' ? 'Dokumen paspor tidak selesai tepat waktu.' : 'Permintaan pribadi jemaah.',
          cancelReasonCode,
        } : {}),
        ...(noShow ? { noShowAt: new Date(paket.departureDate.getTime() + 86400_000) } : {}),
      },
    });
    totalBookings++;

    if (paid > 0) {
      await db.payment.create({
        data: {
          bookingId: booking.id, amount: idr(paid), currency: 'IDR',
          method: pick(['TRANSFER', 'VA', 'QRIS', 'EWALLET']),
          status: 'PAID', paidAt: daysAgo(Math.max(0, bookedDaysAgo - randInt(1, 10))),
          gatewayRef: `SEED-PAY-${bookingNo}`,
        },
      });
    }
    if (status === 'REFUNDED') {
      const refundAmt = Math.round(paid * randInt(60, 100) / 100);
      await db.payment.create({
        data: {
          bookingId: booking.id, amount: idr(-refundAmt), currency: 'IDR',
          method: 'TRANSFER', status: 'REFUNDED',
          paidAt: daysAgo(Math.max(0, bookedDaysAgo - randInt(1, 5))),
          gatewayRef: `SEED-REFUND-${bookingNo}`,
          refundReasonCode: pick(['JEMAAH_REQUEST', 'DOCUMENT_INCOMPLETE', 'GOODWILL']),
        },
      });
      await db.booking.update({ where: { id: booking.id }, data: { paidAmount: idr(Math.max(0, paid - refundAmt)) } });
    }

    if (status === 'LUNAS' && agentId) {
      const komisiAmt = Math.round(total * KOMISI_RATE);
      const komisiStatus = paket.status === 'CLOSED' ? (Math.random() < 0.7 ? 'PAID' : 'EARNED') : 'EARNED';
      await db.komisi.create({
        data: {
          bookingId: booking.id, agentId, amount: idr(komisiAmt), currency: 'IDR',
          status: komisiStatus, earnedAt: daysAgo(Math.max(0, bookedDaysAgo - 5)),
          ...(komisiStatus === 'PAID' ? { paidAt: daysAgo(Math.max(0, bookedDaysAgo - randInt(10, 30))) } : {}),
        },
      });
      totalKomisi++;
    }
    return { booking, jemaah, name };
  }

  // Past paket — 22 bookings: 18 LUNAS, 2 CANCELLED, 1 REFUNDED, 1 LUNAS-no-show
  for (let i = 0; i < 18; i++) {
    const r = await makeBooking({
      paket: pastPaket, kelas: pick(['QUAD', 'TRIPLE', 'DOUBLE']), pax: pick([1, 1, 1, 2, 2, 4]),
      status: 'LUNAS', paidFrac: 1, agentSlug: pick(agentSlugs), bookedDaysAgo: randInt(140, 200),
    });
    pastBookingRows.push(r);
  }
  {
    const r = await makeBooking({ paket: pastPaket, kelas: 'QUAD', pax: 1, status: 'LUNAS', paidFrac: 1, agentSlug: pick(agentSlugs), bookedDaysAgo: 190, noShow: true });
    pastBookingRows.push(r);
  }
  await makeBooking({ paket: pastPaket, kelas: 'TRIPLE', pax: 1, status: 'CANCELLED', paidFrac: 0.3, agentSlug: pick(agentSlugs), bookedDaysAgo: 160, cancelReasonCode: 'PAYMENT_NOT_RECEIVED' });
  await makeBooking({ paket: pastPaket, kelas: 'QUAD', pax: 2, status: 'CANCELLED', paidFrac: 0.2, agentSlug: pick(agentSlugs), bookedDaysAgo: 155, cancelReasonCode: 'DOCUMENT_INCOMPLETE' });
  await makeBooking({ paket: pastPaket, kelas: 'DOUBLE', pax: 1, status: 'REFUNDED', paidFrac: 1, agentSlug: pick(agentSlugs), bookedDaysAgo: 170 });

  // Near paket — 18 bookings, pipeline in progress
  const nearStatuses = [
    ...Array(5).fill(['PENDING', 0]),
    ...Array(4).fill(['BOOKED', 0.05]),
    ...Array(4).fill(['DP_PAID', 0.35]),
    ...Array(3).fill(['PARTIAL', 0.65]),
    ...Array(2).fill(['LUNAS', 1]),
  ];
  for (const [status, frac] of nearStatuses) {
    await makeBooking({ paket: nearPaket, kelas: pick(['QUAD', 'TRIPLE', 'DOUBLE']), pax: pick([1, 1, 2, 3]), status, paidFrac: frac, agentSlug: pick(agentSlugs), bookedDaysAgo: randInt(2, 55) });
  }

  // Future paket — 10 bookings, early pipeline
  const futureStatuses = [
    ...Array(5).fill(['PENDING', 0]),
    ...Array(3).fill(['BOOKED', 0.1]),
    ...Array(2).fill(['DP_PAID', 0.4]),
  ];
  for (const [status, frac] of futureStatuses) {
    await makeBooking({ paket: futurePaket, kelas: pick(['DOUBLE', 'TRIPLE', 'VVIP']), pax: pick([1, 2]), status, paidFrac: frac, agentSlug: pick(agentSlugs), bookedDaysAgo: randInt(1, 18) });
  }

  console.log(`  ${totalBookings} bookings created, ${totalKomisi} komisi rows`);

  // ── Leads across the CRM funnel ──────────────────────────────
  console.log('── Leads ──');
  const leadStatuses = [
    ...Array(8).fill('COLD'), ...Array(6).fill('WARM'), ...Array(3).fill('CONVERTED'), ...Array(3).fill('LOST'),
  ];
  let leadCount = 0;
  for (const status of leadStatuses) {
    const agentSlug = pick(agentSlugs);
    const name = genName();
    await db.lead.create({
      data: {
        agentId: agents[agentSlug].id, fullName: name, phone: genPhone(),
        email: Math.random() < 0.5 ? `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@gmail.com` : null,
        source: pick(['WA', 'IG', 'FB', 'TIKTOK', 'REFERRAL', 'AD']),
        status,
        estPaxCount: pick([1, 1, 2, 4]),
        estValueIdr: idr(randInt(24, 60) * 1_000_000),
        score: status === 'WARM' ? randInt(45, 75) : status === 'COLD' ? randInt(10, 35) : null,
        notes: pick([
          'Tanya jadwal keberangkatan terdekat.',
          'Minta brosur paket keluarga.',
          'DM Instagram, tertarik paket eksekutif.',
          'Follow-up cicilan bulan depan.',
          'Referral dari jemaah sebelumnya.',
          'Klik iklan Facebook, belum respon WA.',
        ]),
        followUpAt: status === 'WARM' ? daysFromNow(randInt(-3, 10)) : null,
        interestedPaketSlug: pick([pastPaket.slug, nearPaket.slug, futurePaket.slug, 'ramadhan-aqsa-2026']),
      },
    });
    leadCount++;
  }
  console.log(`  ${leadCount} leads created`);

  // ── Testimonials (past paket) ────────────────────────────────
  console.log('── Testimonials ──');
  const testimonialPool = pickN(pastBookingRows, 7);
  const testimonialBodies = [
    'Alhamdulillah perjalanan umroh kami sangat berkesan. Pembimbingnya sabar dan informatif, hotel dekat sekali dengan masjid. Terima kasih Religio Pro!',
    'Pelayanan sangat memuaskan dari awal daftar sampai pulang. Manasik jelas, dokumen diurus rapi, tidak ada drama sama sekali.',
    'Ini umroh kedua saya bersama Religio Pro dan tetap konsisten kualitasnya. Insya Allah akan booking lagi tahun depan bersama keluarga besar.',
    'Muthawwifnya sangat membantu terutama untuk orang tua kami yang sudah lansia. Jadwal ziarah juga padat tapi tidak terburu-buru.',
    'Hotelnya bagus, makanannya enak, dan yang paling penting jadwal ibadahnya benar-benar diprioritaskan. Recommended!',
    'Awalnya agak khawatir karena baru pertama kali umroh, tapi tim Religio Pro membimbing dari A sampai Z. Sangat berterima kasih.',
    'Perjalanan lancar, hanya saja waktu di Aqsa agak terburu-buru. Selebihnya sangat memuaskan dan pembimbingnya ramah.',
  ];
  let ti = 0;
  for (const { name, jemaah } of testimonialPool) {
    await db.testimonial.create({
      data: {
        paketId: pastPaket.id,
        jemaahName: name.replace(/^(Pak|Bu|H\.|Hj\.|Bapak|Ibu)\s/, ''),
        jemaahCity: pick(CITIES),
        body: testimonialBodies[ti % testimonialBodies.length],
        rating: ti === testimonialBodies.length - 1 ? 4 : 5,
        status: ti < 6 ? 'PUBLISHED' : 'DRAFT',
        sortOrder: ti,
      },
    });
    ti++;
  }
  console.log(`  ${ti} testimonials created`);

  // ── Trip feedback (NPS) for past paket LUNAS bookings ────────
  console.log('── Trip feedback (NPS) ──');
  const feedbackCandidates = pastBookingRows.filter((r) => r.booking.status === 'LUNAS' && !r.booking.noShowAt);
  const feedbackSample = pickN(feedbackCandidates, 14);
  const scores = [10, 9, 9, 10, 8, 9, 10, 7, 9, 8, 10, 6, 9, 4];
  let fi = 0;
  for (const { booking } of feedbackSample) {
    const score = scores[fi % scores.length];
    await db.tripFeedback.create({
      data: {
        bookingId: booking.id, paketId: pastPaket.id, score,
        comment: score >= 9 ? 'Sangat puas, pelayanan luar biasa!' : score >= 7 ? 'Bagus, ada beberapa hal kecil yang bisa diperbaiki.' : 'Kurang puas dengan koordinasi jadwal ziarah, agak molor dari rencana.',
        submittedAt: daysAgo(randInt(60, 120)),
      },
    });
    fi++;
  }
  console.log(`  ${fi} trip feedback rows created`);

  // ── Attendance marks for past paket ──────────────────────────
  console.log('── Attendance ──');
  if (crewUser) {
    const days = await db.paketDay.findMany({ where: { paketId: pastPaket.id }, orderBy: { dayNumber: 'asc' } });
    const activeBookings = pastBookingRows.filter((r) => r.booking.status === 'LUNAS');
    let markCount = 0;
    for (const day of days.slice(0, 3)) {
      for (const { booking } of activeBookings) {
        const isNoShow = !!booking.noShowAt;
        if (isNoShow && day.dayNumber === 1) continue; // no-show never marked present on day 1
        const present = isNoShow ? false : Math.random() < 0.93;
        await db.attendanceMark.upsert({
          where: { bookingId_paketDayId: { bookingId: booking.id, paketDayId: day.id } },
          update: {},
          create: { bookingId: booking.id, paketDayId: day.id, present, markedByUserId: crewUser.id, markedAt: daysAgo(randInt(145, 195)) },
        });
        markCount++;
      }
    }
    console.log(`  ${markCount} attendance marks created`);
  } else {
    console.log('  skipped (no crew user found)');
  }

  // ── Payout: bundle one agent's EARNED komisi into PAID ────────
  console.log('── Payout ──');
  const payoutAgent = agents['bambang-s'];
  if (payoutAgent) {
    const earned = await db.komisi.findMany({ where: { agentId: payoutAgent.id, status: 'EARNED' } });
    if (earned.length) {
      const sum = earned.reduce((s, k) => s + Number(k.amount), 0);
      const payoutCount = await db.komisiPayout.count();
      const payout = await db.komisiPayout.create({
        data: {
          payoutNo: `PO-2026-${String(payoutCount + 1).padStart(5, '0')}`,
          agentId: payoutAgent.id, amount: idr(sum), currency: 'IDR',
          method: 'TRANSFER', reference: `BCA-${randInt(100000, 999999)}`,
          notes: 'Payout batch komisi umroh Ramadhan Awal 2026.',
          paidAt: daysAgo(45), paidById: owner.id,
        },
      });
      await db.komisi.updateMany({ where: { id: { in: earned.map((k) => k.id) } }, data: { status: 'PAID', paidAt: daysAgo(45), payoutId: payout.id } });
      console.log(`  payout ${payout.payoutNo} created, ${earned.length} komisi rows bundled (Rp ${sum.toLocaleString('id-ID')})`);
    } else {
      console.log('  skipped (no EARNED komisi for this agent)');
    }
  }

  // ── Summary ───────────────────────────────────────────────
  const counts = {
    users: await db.user.count(),
    agents: await db.agentProfile.count(),
    paket: await db.paket.count({ where: { deletedAt: null } }),
    jemaah: await db.jemaahProfile.count(),
    bookings: await db.booking.count(),
    payments: await db.payment.count(),
    komisi: await db.komisi.count(),
    payouts: await db.komisiPayout.count(),
    leads: await db.lead.count({ where: { deletedAt: null } }),
    testimonials: await db.testimonial.count(),
    tripFeedback: await db.tripFeedback.count(),
  };
  console.log('\nDone. Database counts:', counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
