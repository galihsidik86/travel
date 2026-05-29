// Shared helpers for node:test files (tests/*.test.js).
//
// Conventions:
//   - Use `makeTag()` for unique per-test prefixes (mirrors smoke-script pattern).
//   - Re-export `db` from the singleton so tests share the same client and
//     `$disconnect()` only needs to happen in one process-level hook.
//   - DB cleanup: tests are responsible for their own — use the tag prefix on
//     all created rows so a leak from one test doesn't pollute another.
//   - Tests run against the dev DB. There's no separate test DB yet. Don't
//     assert on row counts that include seeded data — count by tag instead.
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { after } from 'node:test';

export { db };

/**
 * Stable-ish unique prefix for the run. Used as a substring/prefix on every
 * created row so test fixtures can be filtered and cleaned independently.
 */
let counter = 0;
export function makeTag(prefix = 't') {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Make a JEMAAH user + linked JemaahProfile. Returns { user, jemaah }.
 * Cleanup hook (registered via `t.after`) wipes the user + profile.
 */
export async function tempJemaah(t, tag) {
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'JEMAAH',
      fullName: `Test ${tag}`, phone: '+62811',
      jemaah: { create: { fullName: `Test ${tag}`, phone: '+62811', email } },
    },
    include: { jemaah: true },
  });
  t.after(async () => {
    // Order matters: any booking owned by this jemaah profile has to go
    // before the profile can be deleted (FK). In a typical test, `tempPaket`
    // already wiped them via cascade, but the after-hooks fire in
    // registration order — so if a paket fixture was created AFTER the
    // jemaah here, paket cleanup hasn't run yet.
    await db.attendanceMark.deleteMany({ where: { booking: { jemaahId: user.jemaah.id } } });
    await db.paymentIntent.deleteMany({ where: { booking: { jemaahId: user.jemaah.id } } });
    await db.payment.deleteMany({ where: { booking: { jemaahId: user.jemaah.id } } });
    await db.komisi.deleteMany({ where: { booking: { jemaahId: user.jemaah.id } } });
    await db.booking.deleteMany({ where: { jemaahId: user.jemaah.id } });
    await db.jemaahDocument.deleteMany({ where: { jemaahId: user.jemaah.id } });
    await db.jemaahProfile.deleteMany({ where: { id: user.jemaah.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

/**
 * Make a MUTHAWWIF user. Cleanup wipes the user + any PaketCrew rows.
 * No JemaahProfile is created — pure crew identity.
 */
export async function tempMuthawwif(t, tag, { status = 'ACTIVE' } = {}) {
  const email = `${tag}-mut@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'MUTHAWWIF',
      fullName: `Crew ${tag}`, phone: '+62811', status,
    },
  });
  t.after(async () => {
    await db.paketCrew.deleteMany({ where: { userId: user.id } });
    await db.attendanceMark.deleteMany({ where: { markedByUserId: user.id } });
    await db.incident.deleteMany({ where: { createdById: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

/**
 * Make a user with a custom role + status — used for admin fixtures
 * (OWNER/SUPERADMIN/MANAJER_OPS) and edge-case role tests.
 */
export async function tempUser(t, tag, { role = 'OWNER', status = 'ACTIVE', deletedAt = null } = {}) {
  const email = `${tag}-${role.toLowerCase()}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role,
      fullName: `${role} ${tag}`, phone: '+62811', status, deletedAt,
    },
  });
  t.after(async () => {
    // Admin users can be ack/resolve actor on incidents — clear those first.
    await db.incident.updateMany({ where: { ackedById: user.id }, data: { ackedById: null } });
    await db.incident.updateMany({ where: { resolvedById: user.id }, data: { resolvedById: null } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

/**
 * Build a minimal ACTIVE paket with one price tier + N itinerary days. Returns
 * the paket row with `days` ordered ascending. Cleanup wipes everything.
 */
export async function tempPaket(t, tag, { dayCount = 0 } = {}) {
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
      ...(dayCount > 0 ? {
        days: { create: Array.from({ length: dayCount }, (_, i) => ({
          dayNumber: i + 1, title: `Day ${i + 1}`, description: '—',
        })) },
      } : {}),
    },
    include: { days: { orderBy: { dayNumber: 'asc' } } },
  });
  t.after(async () => {
    await db.attendanceMark.deleteMany({ where: { paketDay: { paketId: paket.id } } });
    await db.paymentIntent.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.room.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

/**
 * Make a Room under the given paket. Default kelas=QUAD capacity=4.
 * Cleanup runs before paket cleanup (registration order); paket cleanup
 * also defensively wipes rooms by paketId so order doesn't bite.
 */
export async function tempRoom(t, paket, { roomNo, kelas = 'QUAD', capacity = 4, floor = 1, wing = null } = {}) {
  const room = await db.room.create({
    data: {
      paketId: paket.id,
      roomNo: roomNo || `R-${Math.random().toString(36).slice(2, 7)}`,
      kelas, capacity, floor, wing,
    },
  });
  t.after(async () => {
    // Free any bookings pointing at this room first (FK)
    await db.booking.updateMany({ where: { roomId: room.id }, data: { roomId: null } });
    await db.room.deleteMany({ where: { id: room.id } });
  });
  return room;
}

/**
 * Build a minimal PENDING booking under the given paket + jemaah profile.
 * Cleanup is handled by `tempPaket`'s after-hook (cascade by paketId).
 */
export async function tempBooking({ paket, jemaahProfileId, jemaahUserId = null, totalAmount = '1000000' }) {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId: jemaahProfileId, jemaahUserId,
      kelas: 'QUAD', paxCount: 1, totalAmount, paidAmount: '0', status: 'PENDING',
    },
  });
}

/**
 * Audit/log shim for tests where we don't want to pass a real Express req.
 */
export const fakeReq = { ip: '127.0.0.1', headers: {} };
export const systemActor = { email: 'test-runner', role: null };

// Ensure prisma disconnects once after the whole test process exits cleanly.
// node:test doesn't have a global afterAll, so we hook process events.
let _disconnectHooked = false;
function hookDisconnect() {
  if (_disconnectHooked) return;
  _disconnectHooked = true;
  const fn = () => db.$disconnect().catch(() => {});
  process.once('beforeExit', fn);
  process.once('SIGINT', fn);
}
hookDisconnect();
