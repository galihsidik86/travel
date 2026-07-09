// =============================================================
// Religio Pro — demo-realism patch #4: CRM funnel linkage
//
// getAgentFunnel() (src/services/analytics.js) draws its "Cold/Warm/
// Converted" stages from the Lead table and its "Hot booking/Lunas"
// stages from the Booking table — two independently-counted sources,
// not a strict sequential pipeline. seed-demo-realistic.js created
// ~50 bookings directly via Prisma with zero corresponding Lead rows,
// so for any agent+window where Booking-status counts exceed that
// agent's tiny Lead-status counts, the funnel view (which renders each
// stage as % of the smallest/first stage) shows nonsense like "Hot
// booking 400%".
//
// Fix: retroactively create CONVERTED Lead rows pointing at a
// majority of the real bookings that have an agent (Lead.
// convertedBookingId is @unique, so each booking gets at most one).
// This is the structurally honest fix — most real bookings DO trace
// back through a CRM lead — rather than further tuning display math.
// Walk-in (agentId=null) bookings are skipped (no CRM lead for those,
// same as real life). PENDING bookings are skipped (not yet a real
// commitment). CANCELLED/REFUNDED skipped (didn't convert).
//
// Also tops up the COLD/WARM pool a little so the top of the funnel
// isn't razor-thin relative to the now-larger CONVERTED count.
//
// Usage: node --env-file-if-exists=.env scripts/patch-funnel-lead-linkage.js
// =============================================================

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400_000); }
function idr(n) { return Math.round(n).toFixed(2); }

const LEAD_SOURCES = ['WA', 'IG', 'FB', 'TIKTOK', 'REFERRAL', 'AD'];
const MALE_FIRST = ['Ahmad', 'Bambang', 'Hendra', 'Joko', 'Rizki', 'Yusuf', 'Wahyu', 'Slamet', 'Iwan', 'Dedi'];
const FEMALE_FIRST = ['Siti', 'Dewi', 'Fitriani', 'Yuli', 'Sri', 'Rina', 'Sarah', 'Indah', 'Maya', 'Ratna'];
const LAST = ['Wibowo', 'Santoso', 'Kusuma', 'Hidayat', 'Susanto', 'Wijaya', 'Pratama', 'Rahman', 'Firdaus'];
function genName() { return `${pick(Math.random() < 0.5 ? MALE_FIRST : FEMALE_FIRST)} ${pick(LAST)}`; }
const usedPhones = new Set();
function genPhone() {
  const prefixes = ['0811', '0812', '0813', '0821', '0822', '0852', '0878', '0857'];
  let phone;
  do { phone = `${pick(prefixes)}-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`; } while (usedPhones.has(phone));
  usedPhones.add(phone);
  return phone;
}

async function main() {
  // ── 1. Link real bookings to fresh CONVERTED leads ────────────
  console.log('── Linking bookings to CONVERTED leads ──');
  const alreadyLinked = new Set((await db.lead.findMany({ where: { convertedBookingId: { not: null } }, select: { convertedBookingId: true } })).map((l) => l.convertedBookingId));

  const eligible = await db.booking.findMany({
    where: {
      agentId: { not: null },
      status: { in: ['BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS'] },
    },
    select: { id: true, agentId: true, paxCount: true, totalAmount: true, createdAt: true, jemaah: { select: { fullName: true, phone: true } } },
  });
  const candidates = eligible.filter((b) => !alreadyLinked.has(b.id));

  // 70% of eligible, unlinked bookings get a matching converted lead.
  const target = Math.round(candidates.length * 0.7);
  const chosen = [];
  const pool = [...candidates];
  for (let i = 0; i < target && pool.length; i++) {
    chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }

  let linked = 0;
  for (const b of chosen) {
    const leadCreatedAt = new Date(b.createdAt.getTime() - Math.floor(2 + Math.random() * 10) * 86400_000);
    await db.lead.create({
      data: {
        agentId: b.agentId,
        fullName: b.jemaah.fullName, phone: b.jemaah.phone,
        source: pick(LEAD_SOURCES), status: 'CONVERTED',
        estPaxCount: b.paxCount, estValueIdr: idr(Number(b.totalAmount)),
        score: 90,
        notes: 'Lead → booking (retroactive link, rekonsiliasi funnel CRM).',
        convertedAt: b.createdAt, convertedBookingId: b.id,
        createdAt: leadCreatedAt,
      },
    });
    linked++;
  }
  console.log(`  ${linked} / ${candidates.length} eligible bookings linked (${eligible.length - candidates.length} were already linked)`);

  // ── 2. Top up fresh COLD/WARM pipeline so top-of-funnel isn't thin ──
  console.log('── Topping up COLD/WARM leads ──');
  const agents = await db.agentProfile.findMany({ select: { id: true, slug: true } });
  let topped = 0;
  for (const agent of agents) {
    const extra = 3 + Math.floor(Math.random() * 3); // 3-5 per agent
    for (let i = 0; i < extra; i++) {
      const status = Math.random() < 0.55 ? 'COLD' : 'WARM';
      await db.lead.create({
        data: {
          agentId: agent.id, fullName: genName(), phone: genPhone(),
          source: pick(LEAD_SOURCES), status,
          estPaxCount: pick([1, 1, 2, 4]),
          estValueIdr: idr((24 + Math.random() * 40) * 1_000_000),
          score: status === 'WARM' ? 45 + Math.floor(Math.random() * 30) : 10 + Math.floor(Math.random() * 25),
          notes: pick(['Follow-up via WA minggu ini.', 'Tanya cicilan bulan depan.', 'Klik iklan Instagram, belum respon.', 'Referral dari jemaah sebelumnya.']),
          followUpAt: status === 'WARM' ? daysAgo(-Math.floor(1 + Math.random() * 10)) : null,
          createdAt: daysAgo(Math.floor(Math.random() * 20)),
        },
      });
      topped++;
    }
  }
  console.log(`  ${topped} fresh COLD/WARM leads added across ${agents.length} agents`);

  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
