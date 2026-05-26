// Smoke test for 5ss — crew manifest CSV export.
//
// Covers:
//   1. buildCrewManifestCsv returns null for an unassigned crew (route → 404)
//   2. CSV starts with UTF-8 BOM
//   3. Header row matches expected money-stripped columns
//   4. One row per active booking (CANCELLED/REFUNDED excluded — already
//      tested in 5oo via getAssignedManifest, but we re-verify the count)
//   5. Per-curated-type doc state columns reflect actual doc status
//   6. CSV-escape: commas, quotes, and newlines in fields are properly wrapped
//   7. Filename format: crew_manifest_<slug>_<YYYY-MM-DD>.csv
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { assignCrewToPaket, buildCrewManifestCsv } from '../src/services/crewPortal.js';

const tag = `smoke5ss-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

function csvLines(s) { return s.split('\r\n'); }
function parseCsvLine(line) {
  // Tiny RFC 4180 parser — good enough for smoke (no embedded CRLF tests below
  // would mistakenly split here).
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; continue; }
      if (ch === '"') { inQ = true; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function main() {
  console.log(`\n[5ss smoke] tag=${tag}`);

  const passwordHash = await hashPassword('smoke12345');
  const crewA = await db.user.create({
    data: {
      email: `${tag}-mut@example.test`, passwordHash, role: 'MUTHAWWIF',
      fullName: 'Smoke Crew', phone: '+628111111111',
    },
  });
  const crewB = await db.user.create({
    data: {
      email: `${tag}-mut2@example.test`, passwordHash, role: 'MUTHAWWIF',
      fullName: 'Other Crew', phone: '+628222222222',
    },
  });

  const departure = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `5ss-${tag}`, title: 'Paket 5ss',
      departureDate: departure, returnDate: new Date(departure.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0, status: 'ACTIVE',
    },
  });
  await assignCrewToPaket({
    req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null },
    paketSlug: paket.slug, userId: crewA.id,
  });

  // Two jemaah with edge-case names to test escaping
  const jem1 = await db.jemaahProfile.create({
    data: {
      fullName: 'Ahmad, Bin Yusuf', // comma → must be wrapped
      phone: '+62811',
      emergencyContact: 'Istri (0813)',
      passportNo: 'A1234567',
      passportExpiry: new Date('2027-01-15'),
    },
  });
  const jem2 = await db.jemaahProfile.create({
    data: {
      fullName: 'Siti "Aisyah"', // quote → must escape
      phone: '+62822\n0813', // embedded newline (rare but valid)
      emergencyContact: null,
      passportNo: null,
    },
  });

  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: jem1.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'DP_PAID',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: jem2.id,
      kelas: 'TRIPLE', paxCount: 2, totalAmount: '2000000', paidAmount: '0', status: 'PENDING',
    },
  });
  // Cancelled — must be excluded
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: jem1.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'CANCELLED',
    },
  });
  // Add a verified doc for jem1
  await db.jemaahDocument.create({
    data: { jemaahId: jem1.id, type: 'PASSPORT', status: 'VERIFIED', submittedAt: new Date(), verifiedAt: new Date() },
  });

  // 1. Unassigned crew → null
  const noAccess = await buildCrewManifestCsv({ userId: crewB.id, slug: paket.slug });
  assert(noAccess === null, 'unassigned crew gets null (route → 404)');

  // Assigned crew builds CSV
  const out = await buildCrewManifestCsv({ userId: crewA.id, slug: paket.slug });
  assert(out && out.csv, 'assigned crew gets CSV payload');

  // 2. BOM
  assert(out.csv.charCodeAt(0) === 0xFEFF, 'CSV starts with UTF-8 BOM (0xFEFF)');

  // 3. Header columns — no money fields
  const lines = csvLines(out.csv);
  const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ''));
  assert(header.includes('Booking No') && header.includes('Nama Jemaah'), 'header has identity cols');
  assert(header.some((c) => c.startsWith('Doc ')), 'header has per-doc-type cols');
  assert(!header.includes('Total (IDR)') && !header.includes('Dibayar (IDR)'), 'NO money cols (separation of duty)');

  // 4. One row per active booking (2), header + 2 = 3 lines
  assert(lines.length === 3, 'header + 2 active bookings (CANCELLED excluded)');

  // 6. Escaping — find the row with the comma name, verify it round-trips
  const row1Cols = parseCsvLine(lines[1]);
  const row2Cols = parseCsvLine(lines[2]);
  const rowAhmad = [row1Cols, row2Cols].find((r) => r[4] === 'Ahmad, Bin Yusuf');
  assert(rowAhmad, 'comma-in-name preserved through escape/parse');
  const rowSiti = [row1Cols, row2Cols].find((r) => r[4] === 'Siti "Aisyah"');
  assert(rowSiti, 'quote-in-name preserved (escaped as "" then parsed back)');

  // 5. Doc state for jem1: PASSPORT column should be 'verified'
  const passportColIdx = header.indexOf('Doc PASSPORT');
  assert(passportColIdx >= 0, 'PASSPORT column present');
  assert(rowAhmad[passportColIdx] === 'verified', 'verified doc state surfaces in CSV');
  // jem2 has no docs → 'missing'
  assert(rowSiti[passportColIdx] === 'missing', 'no-doc jemaah shows missing');

  // 7. Filename format
  const today = new Date().toISOString().slice(0, 10);
  assert(out.filename === `crew_manifest_5ss-${tag}_${today}.csv`, 'filename matches crew_manifest_<slug>_<date>.csv');

  // Cleanup
  await db.jemaahDocument.deleteMany({ where: { jemaahId: { in: [jem1.id, jem2.id] } } });
  await db.booking.deleteMany({ where: { paketId: paket.id } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: [jem1.id, jem2.id] } } });
  await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.auditLog.deleteMany({ where: { actorEmail: 'sys@test' } });
  await db.user.deleteMany({ where: { id: { in: [crewA.id, crewB.id] } } });
  console.log('  cleanup done');

  console.log('\n[5ss smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5ss smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
