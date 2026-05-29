// Pre-launch smoke for offline-friendly attendance (jemaah crew).
//
// Validates the HTTP + DB side. The IDB queue + DOM behavior is browser-
// only — drive it manually via Chrome DevTools → Network → Offline once
// this script confirms the wiring is sound.
//
// Coverage:
//   1. /shared/attendance-queue.js serves with valid JS content
//   2. attendance-day page renders the new offline UX hooks (sync-pill,
//      net-banner, [data-booking-id], queue script tag)
//   3. POST upsert via form-encoded body succeeds (online happy path)
//   4. Replaying the SAME payload N times leaves the DB in the same state
//      as one call (the idempotency guarantee the queue depends on)
//   5. Subsequent POST with different notes wins (last-write-wins replay)
//
// Run alongside dev server: npm run dev (in another shell), then
//   node scripts/smoke-offline-attendance.js
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { assignCrewToPaket } from '../src/services/crewPortal.js';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const tag = `smoke-off-${Date.now()}`;

function ok(name) { console.log(`  ok    ${name}`); }
function bad(name, detail) { console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); process.exitCode = 1; throw new Error(name); }

function parseCookies(res) {
  const arr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  const jar = {};
  for (const line of arr) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > -1) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function loginAs(email, password) {
  const r1 = await fetch(`${BASE}/login`, { redirect: 'manual' });
  const jar = parseCookies(r1);
  const csrf = jar.rp_csrf;
  if (!csrf) bad('login page mints rp_csrf', 'no cookie');
  const body = new URLSearchParams({ email, password, _csrf: csrf });
  const r2 = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(jar),
    },
    body, redirect: 'manual',
  });
  Object.assign(jar, parseCookies(r2));
  if (r2.status !== 302) bad('login redirect', `status ${r2.status}`);
  return jar;
}

async function fixture() {
  const passwordHash = await hashPassword('smoke12345');
  const crew = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash, role: 'MUTHAWWIF',
      fullName: 'Smoke Crew', phone: '+62800',
    },
  });
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `off-${tag}`, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 5 * 86_400_000),
      durationDays: 5, inclusions: [], exclusions: [], kursiTotal: 5, status: 'ACTIVE',
      days: { create: [{ dayNumber: 1, title: 'Arrival', description: 'Land in Madinah' }] },
    },
    include: { days: true },
  });
  const jem1 = await db.jemaahProfile.create({ data: { fullName: 'Jemaah 1', phone: '+62811' } });
  const jem2 = await db.jemaahProfile.create({ data: { fullName: 'Jemaah 2', phone: '+62812' } });
  const bk1 = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: jem1.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });
  const bk2 = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: jem2.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'BOOKED',
    },
  });
  await assignCrewToPaket({
    req: { ip: '127.0.0.1', headers: {} }, actor: { email: 'sys@test', role: null },
    paketSlug: paket.slug, userId: crew.id,
  });
  return { crew, paket, day: paket.days[0], bookings: [bk1, bk2] };
}

async function cleanup({ crew, paket, bookings }) {
  await db.attendanceMark.deleteMany({ where: { bookingId: { in: bookings.map((b) => b.id) } } });
  await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
  await db.booking.deleteMany({ where: { paketId: paket.id } });
  await db.jemaahProfile.deleteMany({ where: { id: { in: bookings.map((b) => b.jemaahId) } } });
  await db.paketDay.deleteMany({ where: { paketId: paket.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.user.delete({ where: { id: crew.id } });
}

async function main() {
  console.log(`\n[offline-attendance smoke] tag=${tag} base=${BASE}`);

  // 1. Asset reachable + valid JS
  const aj = await fetch(`${BASE}/shared/attendance-queue.js`);
  if (!aj.ok || !(aj.headers.get('content-type') || '').includes('javascript')) bad('attendance-queue.js serves', aj.status);
  const ajBody = await aj.text();
  if (!ajBody.includes('AttendanceQueue')) bad('attendance-queue.js exposes AttendanceQueue', 'body missing AttendanceQueue');
  ok('GET /shared/attendance-queue.js → JS exposes window.AttendanceQueue');

  const fix = await fixture();
  try {
    const jar = await loginAs(fix.crew.email, 'smoke12345');
    ok(`POST /login (MUTHAWWIF ${fix.crew.email}) → 302`);

    // 2. Render attendance-day page; check the new offline UX hooks
    const pageRes = await fetch(`${BASE}/crew/paket/${fix.paket.slug}/attendance/${fix.day.id}`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    if (pageRes.status !== 200) bad('attendance-day renders', `status ${pageRes.status}`);
    const html = await pageRes.text();
    const checks = [
      ['attendance-queue.js script tag', /attendance-queue\.js/],
      ['net-banner element', /id="net-banner"/],
      ['sync-pill class', /class="sync-pill"/],
      ['data-booking-id attribute', /data-booking-id="/],
      ['data-paket-slug on body', /data-paket-slug="/],
      ['data-day-id on body', /data-day-id="/],
    ];
    for (const [label, re] of checks) {
      if (!re.test(html)) bad(`page contains ${label}`, 're not matched');
    }
    ok('GET attendance-day → page exposes offline UX hooks (6 markers)');

    // Extract csrf token from the form so we can POST as the SW/queue would.
    const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) bad('CSRF token present in form', 'regex miss');
    const formCsrf = csrfMatch[1];

    // 3. Online happy path: POST present=on + notes
    async function postMark({ bookingId, present, notes }) {
      const body = new URLSearchParams({ _csrf: formCsrf, notes });
      if (present) body.append('present', 'on');
      const r = await fetch(`${BASE}/crew/paket/${fix.paket.slug}/attendance/${fix.day.id}/${bookingId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader(jar),
        },
        body, redirect: 'manual',
      });
      return r;
    }

    const bk1 = fix.bookings[0];
    let r = await postMark({ bookingId: bk1.id, present: true, notes: 'Pertama' });
    if (r.status !== 302) bad('POST mark (online)', `status ${r.status}`);
    ok('POST attendance mark → 302');

    const m1 = await db.attendanceMark.findFirst({ where: { bookingId: bk1.id, paketDayId: fix.day.id } });
    if (!m1 || m1.present !== true || m1.notes !== 'Pertama') bad('mark stored with present=true', JSON.stringify(m1));
    ok('DB has present=true notes="Pertama"');

    // 4. Replay same payload 3 times — DB stable, no duplicates
    for (let i = 0; i < 3; i++) {
      r = await postMark({ bookingId: bk1.id, present: true, notes: 'Pertama' });
      if (r.status !== 302) bad(`replay ${i + 1} (idempotent)`, `status ${r.status}`);
    }
    const all = await db.attendanceMark.findMany({ where: { bookingId: bk1.id, paketDayId: fix.day.id } });
    if (all.length !== 1) bad('replays produce a single row', `got ${all.length}`);
    ok('replay × 3 → still 1 row (idempotent upsert)');

    // 5. Different payload wins (last-write semantics)
    r = await postMark({ bookingId: bk1.id, present: false, notes: 'Sakit' });
    if (r.status !== 302) bad('overwrite mark', `status ${r.status}`);
    const m2 = await db.attendanceMark.findFirst({ where: { bookingId: bk1.id, paketDayId: fix.day.id } });
    if (m2.present !== false || m2.notes !== 'Sakit') bad('last-write-wins', JSON.stringify(m2));
    ok('different payload → DB reflects last write (notes="Sakit", present=false)');

    // 6. Second booking gets its own row
    const bk2 = fix.bookings[1];
    r = await postMark({ bookingId: bk2.id, present: true, notes: '' });
    if (r.status !== 302) bad('mark second booking', `status ${r.status}`);
    const m3 = await db.attendanceMark.findFirst({ where: { bookingId: bk2.id, paketDayId: fix.day.id } });
    if (!m3 || m3.present !== true) bad('second booking marked independently', JSON.stringify(m3));
    ok('different (bookingId, dayId) tuple → independent row');

    console.log('\nAll checks passed.');
  } finally {
    await cleanup(fix);
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  db.$disconnect();
  process.exit(1);
});
