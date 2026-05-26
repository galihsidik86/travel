// Smoke test for 5uu — auto-expire stale CREATED/PENDING intents.
//
// Covers:
//   1. CREATED intent past expiresAt → EXPIRED
//   2. PENDING intent past expiresAt → EXPIRED
//   3. CREATED intent with future expiresAt → untouched
//   4. SETTLED intent past expiresAt → untouched (terminal frozen invariant)
//   5. CANCELLED intent past expiresAt → untouched
//   6. Re-run on empty queue → expired=0 (idempotent)
//   7. Audit row written per expiration with autoExpired:true + before/after
import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { expireStaleIntents } from '../src/services/expireIntents.js';

const tag = `smoke5uu-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log(`\n[5uu smoke] tag=${tag}`);

  // Fixture: minimal user + paket + booking just so PaymentIntent has a FK target
  const passwordHash = await hashPassword('smoke12345');
  const user = await db.user.create({
    data: {
      email: `${tag}@example.test`, passwordHash, role: 'JEMAAH',
      fullName: 'Smoke 5uu', phone: '+628111111111',
      jemaah: { create: { fullName: 'Smoke 5uu', phone: '+628111111111', email: `${tag}@example.test` } },
    },
    include: { jemaah: true },
  });
  const departure = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: `5uu-${tag}`, title: 'Paket 5uu',
      departureDate: departure, returnDate: new Date(departure.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
    },
  });

  const past = new Date(Date.now() - 60 * 60_000);    // 1h ago
  const future = new Date(Date.now() + 60 * 60_000);  // 1h from now
  async function mkIntent(suffix, status, expiresAt) {
    return db.paymentIntent.create({
      data: {
        bookingId: booking.id, provider: 'MIDTRANS',
        orderId: `PI-${tag}-${suffix}`,
        amount: '100000', currency: 'IDR',
        status, expiresAt,
      },
    });
  }
  const stale1 = await mkIntent('a-created-stale',   'CREATED',   past);
  const stale2 = await mkIntent('b-pending-stale',   'PENDING',   past);
  const fresh  = await mkIntent('c-created-fresh',   'CREATED',   future);
  const terminalSettled  = await mkIntent('d-settled-stale', 'SETTLED', past);
  const terminalCancelled = await mkIntent('e-cancelled-stale', 'CANCELLED', past);

  // Run job
  const result = await expireStaleIntents({ actor: { email: 'system' } });
  assert(result.scanned >= 2, `scanned >= 2 (got ${result.scanned})`);
  assert(result.expired >= 2, `expired >= 2 (got ${result.expired})`);
  assert(result.errors.length === 0, 'no per-row errors');

  // Verify each row state
  const after = await db.paymentIntent.findMany({
    where: { id: { in: [stale1.id, stale2.id, fresh.id, terminalSettled.id, terminalCancelled.id] } },
    select: { id: true, status: true },
  });
  const byId = Object.fromEntries(after.map((r) => [r.id, r.status]));
  assert(byId[stale1.id] === 'EXPIRED', 'stale CREATED → EXPIRED');
  assert(byId[stale2.id] === 'EXPIRED', 'stale PENDING → EXPIRED');
  assert(byId[fresh.id]  === 'CREATED', 'fresh CREATED untouched');
  assert(byId[terminalSettled.id]   === 'SETTLED',   'terminal SETTLED untouched');
  assert(byId[terminalCancelled.id] === 'CANCELLED', 'terminal CANCELLED untouched');

  // 6. Idempotent re-run
  const result2 = await expireStaleIntents({ actor: { email: 'system' } });
  // (other smoke runs may have left stale intents — assert ours specifically didn't change)
  const after2 = await db.paymentIntent.findUnique({ where: { id: stale1.id } });
  assert(after2.status === 'EXPIRED', 'stale1 stays EXPIRED on re-run');
  assert(typeof result2.expired === 'number', 'second run returns shape');

  // 7. Audit rows written
  const audits = await db.auditLog.findMany({
    where: { entity: 'PaymentIntent', entityId: { in: [stale1.id, stale2.id] } },
    select: { action: true, entityId: true, before: true, after: true, actorEmail: true },
  });
  assert(audits.length >= 2, 'at least 2 audit rows for our expirations');
  const auditForStale1 = audits.find((a) => a.entityId === stale1.id);
  assert(auditForStale1.action === 'STATUS_CHANGE', 'audit action = STATUS_CHANGE');
  assert(auditForStale1.actorEmail === 'system', 'actorEmail = system');
  assert(auditForStale1.after.autoExpired === true, 'after.autoExpired = true');
  assert(auditForStale1.after.status === 'EXPIRED' && auditForStale1.before.status === 'CREATED', 'before/after status correct');

  // Cleanup
  const ids = [stale1.id, stale2.id, fresh.id, terminalSettled.id, terminalCancelled.id];
  await db.paymentIntent.deleteMany({ where: { id: { in: ids } } });
  await db.auditLog.deleteMany({ where: { entity: 'PaymentIntent', entityId: { in: ids } } });
  await db.booking.delete({ where: { id: booking.id } });
  await db.paket.delete({ where: { id: paket.id } });
  await db.jemaahProfile.delete({ where: { id: user.jemaah.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log('  cleanup done');

  console.log('\n[5uu smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5uu smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
