// =============================================================
// Religio Pro — DB seed
// 1 owner + 1 agent (slug "ahmad-w") + 1 paket lengkap
// (Umroh Akhir Ramadhan + Aqsa & Petra) untuk step 4 wiring.
// Idempotent — jalankan ulang aman.
// =============================================================

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();

async function upsertUser({ email, password, role, fullName, phone }) {
  const passwordHash = await bcrypt.hash(password, 10);
  return db.user.upsert({
    where: { email },
    update: { fullName, phone, role },
    create: { email, passwordHash, role, fullName, phone },
  });
}

async function main() {
  console.log('Seeding…');

  // ── Owner / admin ─────────────────────────────────────────
  const owner = await upsertUser({
    email: 'owner@religio.pro',
    password: 'owner12345',
    role: 'OWNER',
    fullName: 'Pemilik Religio Pro',
    phone: '0857-1569-0293',
  });
  await db.staffProfile.upsert({
    where: { userId: owner.id },
    update: {},
    create: { userId: owner.id, department: 'Direksi', position: 'Owner' },
  });

  // ── Kasir: front-desk cashier ──────────────────────────────
  const kasirUser = await upsertUser({
    email: 'kasir@religio.pro',
    password: 'kasir12345',
    role: 'KASIR',
    fullName: 'Sdri. Rina Kasir',
    phone: '0813-1111-2222',
  });
  await db.staffProfile.upsert({
    where: { userId: kasirUser.id },
    update: { department: 'Keuangan', position: 'Kasir Front Desk' },
    create: { userId: kasirUser.id, department: 'Keuangan', position: 'Kasir Front Desk' },
  });

  // ── Agent: H. Ahmad Wibowo (slug ahmad-w) ─────────────────
  const agentUser = await upsertUser({
    email: 'ahmad@religio.pro',
    password: 'ahmad12345',
    role: 'AGEN',
    fullName: 'H. Ahmad Wibowo',
    phone: '0812-3456-7890',
  });
  const agent = await db.agentProfile.upsert({
    where: { userId: agentUser.id },
    update: {
      displayName: 'H. Ahmad Wibowo',
      slug: 'ahmad-w',
      igHandle: 'religio.ahmad',
      whatsapp: '0812-3456-7890',
      tier: 'Mitra Resmi · 8 tahun',
      isVerified: true,
    },
    create: {
      userId: agentUser.id,
      slug: 'ahmad-w',
      displayName: 'H. Ahmad Wibowo',
      igHandle: 'religio.ahmad',
      whatsapp: '0812-3456-7890',
      bio: 'Mitra resmi Religio Pro sejak 2018 — sudah membimbing 2.400+ jemaah ke Tanah Suci.',
      tier: 'Mitra Resmi · 8 tahun',
      isVerified: true,
    },
  });

  // ── Paket: Umroh Akhir Ramadhan + Aqsa & Petra ─────────────
  const paketData = {
      slug: 'ramadhan-aqsa-2026',
      title: 'Umroh Akhir Ramadhan + Aqsa & Petra',
      subtitle: '14 Hari · 13 Malam · Lailatul Qadr di Mekkah',
      heroTitleHtml: 'Umroh Akhir<br>Ramadhan,<br><em>Plus Aqsa &amp;<br>Petra.</em>',
      arabicTagline: 'لَبَّيْكَ اللَّهُمَّ لَبَّيْكَ',
      translitTagline: '"Labbaik Allahumma Labbaik" — kami penuhi panggilan-Mu, ya Allah.',
      departureDate: new Date('2027-03-15T23:55:00+07:00'),
      returnDate: new Date('2027-03-28T13:00:00+07:00'),
      durationDays: 14,
      airline: 'Garuda Indonesia',
      airlineCode: 'GA-980',
      routeFrom: 'CGK',
      routeTo: 'JED',
      heroDescription:
        'Empat belas hari penuh berkah — 10 malam terakhir Ramadhan di Mekkah, plus ziarah ke Masjid Al-Aqsa dan Kota Petra. Diatur untuk jemaah middle-up dengan standar VVIP.',
      inclusions: [
        'Visa Umroh resmi (Tasreeh tasaruq)',
        'Visa Yordania & izin Yerusalem',
        'Tiket pesawat PP Garuda direct',
        'Pesawat Mekkah → Amman',
        'Hotel Madinah ★★★★★ 4 malam',
        'Hotel Mekkah ★★★★★ 6 malam',
        'Hotel Yerusalem ★★★★ 2 malam',
        'Hotel Petra ★★★★★ 1 malam',
        'Makan 3× per hari di Saudi',
        'Iftar & sahur catering',
        'Transportasi AC penuh',
        'Muthawwif pembimbing tetap',
        'Air Zamzam 5L resmi',
        'Manasik 4× sebelum berangkat',
        'Koper Religio Pro + seragam',
        'Tas paspor & tas tangan',
        'Sajadah & mukena premium',
        'Ihram + sabuk + sandal',
        'Buku doa + audio guide app',
        'Dam sunnah resmi',
        'Asuransi perjalanan AXA',
        'Sertifikat & album digital',
      ],
      exclusions: [
        'Suntik meningitis (Rp 350rb)',
        'Pembuatan paspor baru',
        'PCR/swab jika diwajibkan',
        'Kelebihan bagasi di atas 30kg',
        'Pengeluaran pribadi & oleh-oleh',
        'Telepon dari kamar hotel',
        'Tip extra untuk muthawwif/sopir',
      ],
      trustBadges: [
        { label: 'Izin Kemenag', value: 'U-129' },
        { label: 'SISKOPATUH', value: 'Terdaftar' },
        { label: 'AMPHURI', value: 'Anggota Aktif' },
        { label: 'Asuransi', value: 'AXA Travel' },
        { label: 'UU PDP', value: 'Compliant' },
      ],
      kursiTotal: 45,
      kursiTerisi: 28,
      manifestClosesAt: new Date('2027-01-31T17:00:00+07:00'),
      status: 'ACTIVE',
      publishedAt: new Date(),
      createdById: owner.id,
  };
  const paket = await db.paket.upsert({
    where: { slug: paketData.slug },
    update: paketData,
    create: paketData,
  });

  // Hotels — clear and re-insert (idempotent)
  await db.paketHotel.deleteMany({ where: { paketId: paket.id } });
  await db.paketHotel.createMany({
    data: [
      {
        paketId: paket.id,
        city: 'MADINAH',
        name: 'Anwar Al Madinah Movenpick',
        stars: 5,
        distance: '50m Nabawi',
        description:
          'Hotel pertama yang akan menyambut Anda. Menara putih persis di depan Pintu 332 Masjid Nabawi — Raudhah hanya 6 menit langkah kaki.',
        nights: 4,
        order: 1,
      },
      {
        paketId: paket.id,
        city: 'MEKKAH',
        name: 'Hilton Suites Makkah',
        stars: 5,
        distance: '300m Haram',
        description:
          'Lantai eksekutif menghadap langsung ke Kabah. Kamar suite dengan ruang tamu terpisah — privasi dan ketenangan VVIP menjelang Lailatul Qadr.',
        nights: 6,
        order: 2,
      },
      {
        paketId: paket.id,
        city: 'AQSA',
        name: 'Olive Tree Boutique',
        stars: 4,
        distance: 'Kota Tua Yerusalem',
        nights: 2,
        order: 3,
      },
      {
        paketId: paket.id,
        city: 'PETRA',
        name: 'Mövenpick Petra',
        stars: 5,
        distance: 'Pintu masuk Petra',
        nights: 1,
        order: 4,
      },
    ],
  });

  // Prices
  await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
  await db.paketHarga.createMany({
    data: [
      {
        paketId: paket.id,
        kelas: 'QUAD',
        label: 'Empat / kamar',
        caption: 'Sharing 4 jemaah · bunking diatur via app',
        priceIdr: '62000000',
        cicilanIdr: '5170000',
        cicilanMonths: 12,
        perks: [
          'Hotel bintang 5 dekat masjid',
          'Pesawat ekonomi Garuda direct',
          'Plus Aqsa & Petra',
          'Bagasi 30kg + zamzam 5L',
        ],
      },
      {
        paketId: paket.id,
        kelas: 'TRIPLE',
        label: 'Tiga / kamar',
        caption: 'Sharing 3 jemaah · kamar lebih lapang',
        priceIdr: '68000000',
        cicilanIdr: '5670000',
        cicilanMonths: 12,
        perks: [
          'Semua benefit Quad',
          'Kamar lebih lapang',
          'Sahur catering 4 menu',
          'Welcome gift premium',
        ],
      },
      {
        paketId: paket.id,
        kelas: 'DOUBLE',
        label: 'Dua / kamar',
        caption: 'Sharing 2 jemaah · untuk pasangan suami-istri',
        priceIdr: '76000000',
        cicilanIdr: '6330000',
        cicilanMonths: 12,
        perks: [
          'Semua benefit Triple',
          'Kamar pasangan privat',
          'Iftar private hotel',
          'Perlengkapan VIP gold-edition',
        ],
        isFeatured: true,
      },
      {
        paketId: paket.id,
        kelas: 'VVIP',
        label: 'Suite Eksekutif',
        caption: 'Lantai eksekutif · view langsung ke Kabah',
        priceIdr: '89000000',
        cicilanIdr: '7420000',
        cicilanMonths: 12,
        perks: [
          'Suite view Kabah langsung',
          'Bisnis class opsional (+Rp 28Jt)',
          'Pendamping pribadi 1:5',
          'Akses lounge tasreeh khusus',
        ],
      },
    ],
  });

  // Itinerary
  await db.paketDay.deleteMany({ where: { paketId: paket.id } });
  await db.paketDay.createMany({
    data: [
      {
        paketId: paket.id,
        dayNumber: 1,
        dayRange: 'Hari 01',
        dateLabel: '25',
        monthLabel: 'Mar 2026',
        title: 'Jakarta → Madinah',
        description:
          'Manasik final 14:00 di kantor pusat. Penerbangan Garuda GA-980 23:55 dari CGK Terminal 3. Tiba di Madinah Subuh, ditemui pembimbing tetap.',
        tags: ['Manasik Final', 'CGK · T3', 'Direct Flight'],
        highlight: true,
        pembimbingTitle: 'Catatan Pembimbing',
        pembimbingNote:
          'Bagasi maks 30kg + cabin 7kg. Air zamzam diatur tim — Anda tidak perlu membawa apapun di tas tangan.',
      },
      {
        paketId: paket.id,
        dayNumber: 2,
        dayRange: 'Hari 02–05',
        dateLabel: '26–29',
        monthLabel: 'Mar · Madinah',
        title: 'Salam untuk Rasul',
        description:
          "Empat malam di Madinah dengan ritual Arba'in, ziarah Raudhah, Quba, Uhud, dan kebun kurma. Iftar bersama keluarga group.",
        tags: ["Arba'in", 'Raudhah · slot khusus', 'Quba · Uhud', 'Kebun Kurma'],
        pembimbingTitle: 'Highlight',
        pembimbingNote:
          'Slot Raudhah untuk jemaah pria via Tasreeh resmi, untuk jemaah wanita 2 sesi (subuh & isya). Tidak ada antrian acak.',
      },
      {
        paketId: paket.id,
        dayNumber: 6,
        dayRange: 'Hari 06',
        dateLabel: '30',
        monthLabel: 'Mar · Miqat',
        title: 'Bir Ali → Mekkah · niat umroh',
        description:
          'Mandi sunnah dan miqat di Masjid Bir Ali. Berangkat ke Mekkah sore hari. Thawaf umroh setibanya di hotel, dibimbing penuh oleh muthawwif.',
        tags: ['Niat Umroh', 'Bir Ali', 'Thawaf · audio guide aktif'],
        highlight: true,
        pembimbingTitle: 'Smart Audio Guide',
        pembimbingNote:
          'Aplikasi Jemaah memutar audio doa dengan otomatis tiap putaran — jemaah lansia tidak perlu menghafal.',
      },
      {
        paketId: paket.id,
        dayNumber: 7,
        dayRange: 'Hari 07–10',
        dateLabel: '31–03',
        monthLabel: 'Mar–Apr · Mekkah',
        title: 'Sepuluh malam terakhir Ramadhan',
        description:
          "Empat malam puncak di Mekkah — i'tikaf, qiyamul lail, dan harap-harap Lailatul Qadr. Ziarah Jabal Tsur, Jabal Rahmah, Mina, dan Arafah pada siang teduh.",
        tags: ['Lailatul Qadr', "I'tikaf", 'Ziarah Mina–Arafah'],
        pembimbingTitle: 'Iftar & Sahur',
        pembimbingNote:
          'Iftar dengan paket makanan resmi pemerintah Saudi di halaman Haram. Sahur catering 4 menu rotasi di hotel.',
      },
      {
        paketId: paket.id,
        dayNumber: 11,
        dayRange: 'Hari 11',
        dateLabel: '04',
        monthLabel: 'Apr · Aqsa',
        title: 'Yerusalem · masjid ketiga',
        description:
          'Penerbangan Mekkah → Amman, lalu border crossing ke Yerusalem. Sholat di Masjid Al-Aqsa, ziarah Dome of the Rock, dan kawasan Kota Tua.',
        tags: ['Plus Aqsa', 'Visa Yordania disiapkan', 'Dome of the Rock'],
        pembimbingTitle: 'Dokumen',
        pembimbingNote:
          'Visa Yordania dan izin crossing diurus tim — Anda tinggal hadir dengan paspor (sudah harus aktif min. 7 bulan).',
      },
      {
        paketId: paket.id,
        dayNumber: 12,
        dayRange: 'Hari 12',
        dateLabel: '05',
        monthLabel: 'Apr · Petra',
        title: 'Petra · kota mawar',
        description:
          'Day tour ke Kota Petra (UNESCO World Heritage). Treasury, Siq, dan makan siang lokal. Kembali ke Amman untuk persiapan pulang.',
        tags: ['UNESCO Heritage', 'Mövenpick Petra'],
        pembimbingTitle: 'Fisik & Lansia',
        pembimbingNote:
          'Tersedia opsi kuda & golf cart untuk jemaah yang tidak ingin berjalan kaki sepanjang 1.2 km.',
      },
      {
        paketId: paket.id,
        dayNumber: 13,
        dayRange: 'Hari 13–14',
        dateLabel: '06–07',
        monthLabel: 'Apr · Pulang',
        title: 'Amman → Jakarta · pulang sebagai tamu Allah',
        description:
          'Penerbangan Royal Jordanian RJ-185 ke CGK transit Doha. Tiba Tanah Air 07 April siang. Sertifikat & album digital langsung dikirim ke aplikasi.',
        tags: ['Album Digital', 'Sertifikat resmi', 'Reuni jemaah'],
        highlight: true,
        pembimbingTitle: 'After-care',
        pembimbingNote:
          'Reuni jemaah satu rombongan diadakan 30 hari setelah kepulangan di Jakarta & Surabaya — gratis.',
      },
    ],
  });

  // ── Rooms for ramadhan-aqsa-2026 (idempotent via @@unique paketId+roomNo) ──
  const KAP = { QUAD: 4, TRIPLE: 3, DOUBLE: 2, VVIP: 1 };
  const demoRooms = [
    { roomNo: 'M-401', floor: 4, wing: 'Selatan', kelas: 'QUAD' },
    { roomNo: 'M-402', floor: 4, wing: 'Selatan', kelas: 'QUAD' },
    { roomNo: 'M-403', floor: 4, wing: 'Selatan', kelas: 'QUAD' },
    { roomNo: 'M-404', floor: 4, wing: 'Selatan', kelas: 'QUAD' },
    { roomNo: 'M-405', floor: 4, wing: 'Utara',   kelas: 'TRIPLE' },
    { roomNo: 'M-406', floor: 4, wing: 'Utara',   kelas: 'TRIPLE' },
    { roomNo: 'M-407', floor: 4, wing: 'Utara',   kelas: 'TRIPLE' },
    { roomNo: 'M-408', floor: 4, wing: 'Utara',   kelas: 'TRIPLE' },
    { roomNo: 'M-501', floor: 5, wing: 'Selatan', kelas: 'DOUBLE' },
    { roomNo: 'M-502', floor: 5, wing: 'Selatan', kelas: 'DOUBLE' },
    { roomNo: 'M-503', floor: 5, wing: 'Eksekutif', kelas: 'VVIP' },
    { roomNo: 'M-504', floor: 5, wing: 'Eksekutif', kelas: 'VVIP' },
  ];
  for (const r of demoRooms) {
    await db.room.upsert({
      where: { paketId_roomNo: { paketId: paket.id, roomNo: r.roomNo } },
      update: { floor: r.floor, wing: r.wing, kelas: r.kelas, capacity: KAP[r.kelas] },
      create: { paketId: paket.id, roomNo: r.roomNo, floor: r.floor, wing: r.wing, kelas: r.kelas, capacity: KAP[r.kelas] },
    });
  }

  // ── Demo bookings for agent ahmad-w (idempotent via bookingNo) ──
  // Cukup untuk mengisi kanban CRM saat demo step 5.
  const KOMISI_RATE = 0.06;
  const demoBookings = [
    { bookingNo: 'RP-DEMO-00001', name: 'Pak Hasan Wibowo',   phone: '0811-2233-4455', kelas: 'QUAD',   pax: 1, status: 'BOOKED',   paidPct: 0.10 },
    { bookingNo: 'RP-DEMO-00002', name: 'Bu Hartini Susanto', phone: '0822-3344-5566', kelas: 'DOUBLE', pax: 2, status: 'DP_PAID',  paidPct: 0.33 },
    { bookingNo: 'RP-DEMO-00003', name: 'Pak Joko Wibowo',    phone: '0833-4455-6677', kelas: 'TRIPLE', pax: 4, status: 'PARTIAL',  paidPct: 0.55 },
    { bookingNo: 'RP-DEMO-00004', name: 'Ahmad Fauzi',        phone: '0844-5566-7788', kelas: 'QUAD',   pax: 1, status: 'LUNAS',    paidPct: 1.00 },
    { bookingNo: 'RP-DEMO-00005', name: 'Siti Rahmah',        phone: '0855-6677-8899', kelas: 'TRIPLE', pax: 1, status: 'LUNAS',    paidPct: 1.00 },
  ];

  const priceByKelas = Object.fromEntries(
    (await db.paketHarga.findMany({ where: { paketId: paket.id } }))
      .map((p) => [p.kelas, Number(p.priceIdr)]),
  );

  for (const d of demoBookings) {
    const total = priceByKelas[d.kelas] * d.pax;
    const paid = Math.round(total * d.paidPct);

    const existing = await db.booking.findUnique({ where: { bookingNo: d.bookingNo } });
    const jemaahId = existing?.jemaahId
      ?? (await db.jemaahProfile.create({ data: { fullName: d.name, phone: d.phone } })).id;

    const booking = await db.booking.upsert({
      where: { bookingNo: d.bookingNo },
      update: {
        status: d.status,
        totalAmount: total.toFixed(2),
        paidAmount: paid.toFixed(2),
      },
      create: {
        bookingNo: d.bookingNo,
        paketId: paket.id,
        jemaahId,
        agentId: agent.id,
        agentSlugCap: agent.slug,
        kelas: d.kelas,
        paxCount: d.pax,
        totalAmount: total.toFixed(2),
        paidAmount: paid.toFixed(2),
        currency: 'IDR',
        status: d.status,
      },
    });

    // Demo Payment row (idempotent via gatewayRef) — only if there's paid > 0
    if (paid > 0) {
      const gatewayRef = 'DEMO-PAY-' + d.bookingNo;
      const existingPay = await db.payment.findUnique({ where: { gatewayRef } });
      if (!existingPay) {
        await db.payment.create({
          data: {
            bookingId: booking.id,
            amount: paid.toFixed(2),
            currency: 'IDR',
            method: d.status === 'LUNAS' ? 'TRANSFER' : 'VA',
            status: 'PAID',
            paidAt: new Date(),
            gatewayRef,
          },
        });
      }
    }

    // Komisi: ENABLE on LUNAS only, idempotent (one row per booking for demo)
    if (d.status === 'LUNAS') {
      const komisiAmount = Math.round(total * KOMISI_RATE);
      const existingKomisi = await db.komisi.findFirst({ where: { bookingId: booking.id } });
      if (!existingKomisi) {
        await db.komisi.create({
          data: {
            bookingId: booking.id,
            agentId: agent.id,
            amount: komisiAmount.toFixed(2),
            currency: 'IDR',
            status: 'EARNED',
            earnedAt: new Date(),
          },
        });
      }
    }
  }

  // ── Demo leads for agent ahmad-w (idempotent via phone+agentId) ──
  const demoLeads = [
    { fullName: 'Pak Hasan Wibowo',  phone: '0888-DEMO-001', source: 'WA',       status: 'COLD', estPaxCount: 1, estValueIdr: 32500000, score: 18, notes: 'Tertangkap dari iklan WhatsApp · butuh follow-up' },
    { fullName: 'Bu Yuli Anwar',     phone: '0888-DEMO-002', source: 'IG',       status: 'COLD', estPaxCount: 1, estValueIdr: 35800000, score: 22, notes: 'Komen post Reels · tanya jadwal Mei' },
    { fullName: 'Pak Nurdin Latif',  phone: '0888-DEMO-003', source: 'FB',       status: 'COLD', estPaxCount: 2, estValueIdr: 65000000, score: 16, notes: 'Klik landing page · belum balas DM' },
    { fullName: 'Bu Hartini Susanto',phone: '0888-DEMO-004', source: 'WA',       status: 'WARM', estPaxCount: 2, estValueIdr: 78000000, score: 62, notes: 'Minta brosur paket VVIP keluarga · F/U besok 10:00', interestedKelas: 'VVIP', interestedPaketSlug: 'ramadhan-aqsa-2026' },
    { fullName: 'Pak Joko Wibowo',   phone: '0888-DEMO-005', source: 'REFERRAL', status: 'WARM', estPaxCount: 4, estValueIdr: 143000000, score: 55, notes: 'Referral dari Pak Ahmad Fauzi · keluarga 4 PAX', interestedKelas: 'TRIPLE' },
    { fullName: 'Bu Sarah Hidayat',  phone: '0888-DEMO-006', source: 'IG',       status: 'WARM', estPaxCount: 1, estValueIdr: 29800000, score: 48, notes: 'DM tanya cicilan · perlu telepon balik hari ini' },
  ];

  for (const l of demoLeads) {
    const existing = await db.lead.findFirst({
      where: { agentId: agent.id, phone: l.phone, deletedAt: null },
    });
    const data = {
      fullName: l.fullName,
      phone: l.phone,
      source: l.source,
      status: l.status,
      estPaxCount: l.estPaxCount ?? null,
      estValueIdr: l.estValueIdr != null ? l.estValueIdr.toFixed(2) : null,
      score: l.score ?? null,
      notes: l.notes ?? null,
      interestedKelas: l.interestedKelas ?? null,
      interestedPaketSlug: l.interestedPaketSlug ?? null,
    };
    if (existing) {
      await db.lead.update({ where: { id: existing.id }, data });
    } else {
      await db.lead.create({ data: { agentId: agent.id, ...data } });
    }
  }

  // ── Audit ────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      actorUserId: owner.id,
      actorEmail: owner.email,
      actorRole: 'OWNER',
      action: 'CREATE',
      entity: 'Paket',
      entityId: paket.id,
      after: { slug: paket.slug, title: paket.title },
    },
  });

  // ── Summary ──────────────────────────────────────────────
  const counts = {
    users: await db.user.count(),
    agents: await db.agentProfile.count(),
    paket: await db.paket.count(),
    hotels: await db.paketHotel.count(),
    prices: await db.paketHarga.count(),
    days: await db.paketDay.count(),
    bookings: await db.booking.count(),
    payments: await db.payment.count(),
    rooms: await db.room.count(),
    komisi: await db.komisi.count(),
    leads: await db.lead.count(),
    audit: await db.auditLog.count(),
  };
  console.log('Done. Database counts:', counts);
  console.log('\nLogin sample:');
  console.log('  owner@religio.pro / owner12345  (role: OWNER)');
  console.log('  kasir@religio.pro / kasir12345  (role: KASIR)');
  console.log('  ahmad@religio.pro / ahmad12345  (role: AGEN, slug: ahmad-w)');
  console.log('\nPaket sample:');
  console.log(`  slug: ${paket.slug}`);
  console.log(`  URL (step 4): /p/${paket.slug}?a=${agent.slug}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
