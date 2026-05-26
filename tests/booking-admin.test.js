// bookingAdmin service tests: cancelBooking (5e?/refund precursor),
// transferBookingAgent (5q), updateBookingNotes (5l? no-op skip invariant).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  db, makeTag, tempJemaah, tempPaket, tempBooking, fakeReq, systemActor,
} from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';
import {
  cancelBooking, transferBookingAgent, updateBookingNotes,
} from '../src/services/bookingAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

// Build an AgentProfile + linked AGEN user. Cleanup wipes both.
async function tempAgent(t, tag, opts = {}) {
  const passwordHash = await hashPassword('test12345');
  const user = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: opts.slug || `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`,
        whatsapp: '+62811',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.updateMany({ where: { agentId: user.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

describe('updateBookingNotes — no-op skip', () => {
  test('setting same value does NOT write an audit row', async (t) => {
    const tag = makeTag('notes');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    // First write: notes go from null → "abc"
    await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: 'abc' });
    const auditsAfter1 = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    assert.equal(auditsAfter1, 1, 'first write produces 1 audit row');

    // Same value again — should short-circuit
    await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: 'abc' });
    const auditsAfter2 = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    assert.equal(auditsAfter2, 1, 'no-op skipped audit log');

    // Whitespace differences also collapse (trim before compare)
    await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: '  abc  ' });
    const auditsAfter3 = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    assert.equal(auditsAfter3, 1, 'trim-equivalent value still a no-op');

    // Real change DOES write
    await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: 'changed' });
    const auditsAfter4 = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    assert.equal(auditsAfter4, 2, 'real change writes a 2nd audit row');

    // Cleanup audits
    t.after(() => db.auditLog.deleteMany({
      where: { entity: 'Booking', entityId: booking.id },
    }));
  });

  test('empty string normalised to null', async (t) => {
    const tag = makeTag('notes-empty');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });

    await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: 'value' });
    const u1 = await updateBookingNotes({ ...ctx, bookingId: booking.id, notes: '' });
    assert.equal(u1.notes, null, 'empty string → null');
    t.after(() => db.auditLog.deleteMany({
      where: { entity: 'Booking', entityId: booking.id },
    }));
  });
});

describe('cancelBooking', () => {
  test('reason required (min 3 chars)', async (t) => {
    const tag = makeTag('cancel-reason');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    await assert.rejects(
      cancelBooking({ ...ctx, bookingId: booking.id, reason: 'no' }),
      (err) => err.code === 'CANCEL_REASON_REQUIRED',
    );
  });

  test('seats freed + room unassigned + EARNED komisi → CANCELLED', async (t) => {
    const tag = makeTag('cancel');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agent = await tempAgent(t, tag);

    // Build booking with agent + pay it to LUNAS so a komisi row gets EARNED
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 2, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    // Bump paket's kursiTerisi to mirror what createBooking would have done
    await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 2 } });
    // Pay LUNAS → komisi gets EARNED
    await recordPayment({
      ...ctx, bookingId: booking.id, amount: 1_000_000, method: 'TRANSFER',
    });
    const komisiBefore = await db.komisi.findFirst({ where: { bookingId: booking.id } });
    assert.equal(komisiBefore?.status, 'EARNED', 'LUNAS triggered EARNED komisi');

    const paketBefore = await db.paket.findUnique({ where: { id: paket.id }, select: { kursiTerisi: true } });
    assert.equal(paketBefore.kursiTerisi, 2, 'seats currently held');

    // Cancel
    const cancelled = await cancelBooking({
      ...ctx, bookingId: booking.id, reason: 'jemaah change of plan',
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.roomId, null, 'room cleared (was null already, still null)');
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.cancelRequested, false, 'cancel request flags cleared');

    // Seats released
    const paketAfter = await db.paket.findUnique({ where: { id: paket.id }, select: { kursiTerisi: true } });
    assert.equal(paketAfter.kursiTerisi, 0, 'seats released back to pool');

    // Komisi flipped EARNED → CANCELLED
    const komisiAfter = await db.komisi.findFirst({ where: { bookingId: booking.id } });
    assert.equal(komisiAfter.status, 'CANCELLED');
  });

  test('refuses double-cancel', async (t) => {
    const tag = makeTag('cancel-dupe');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'first cancel' });
    await assert.rejects(
      cancelBooking({ ...ctx, bookingId: booking.id, reason: 'second cancel' }),
      (err) => err.code === 'ALREADY_CLOSED',
    );
  });
});

describe('transferBookingAgent', () => {
  test('agentSlugCap NEVER mutated; PENDING komisi re-points; EARNED stays by default', async (t) => {
    const tag = makeTag('xfer');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agentFrom = await tempAgent(t, `${tag}-from`);
    const agentTo = await tempAgent(t, `${tag}-to`);

    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
        agentId: agentFrom.agent.id, agentSlugCap: agentFrom.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    // Mix of komisi statuses to test re-routing logic
    await db.komisi.createMany({ data: [
      { bookingId: booking.id, agentId: agentFrom.agent.id, amount: '60000', currency: 'IDR', status: 'PENDING' },
      { bookingId: booking.id, agentId: agentFrom.agent.id, amount: '60000', currency: 'IDR', status: 'EARNED', earnedAt: new Date() },
      { bookingId: booking.id, agentId: agentFrom.agent.id, amount: '60000', currency: 'IDR', status: 'PAID', paidAt: new Date() },
    ] });

    const result = await transferBookingAgent({
      ...ctx, bookingId: booking.id, toAgentId: agentTo.agent.id,
      reason: 'rebalance load',
    });
    assert.equal(result.noop, false);
    assert.equal(result.booking.agentId, agentTo.agent.id);
    assert.equal(result.booking.agentSlugCap, agentFrom.agent.slug,
      'agentSlugCap UNCHANGED — historical URL-of-origin trail');

    // PENDING re-pointed; EARNED + PAID stay with original
    const komisi = await db.komisi.findMany({ where: { bookingId: booking.id } });
    const pending = komisi.find((k) => k.status === 'PENDING');
    const earned = komisi.find((k) => k.status === 'EARNED');
    const paid = komisi.find((k) => k.status === 'PAID');
    assert.equal(pending.agentId, agentTo.agent.id, 'PENDING → new agent');
    assert.equal(earned.agentId, agentFrom.agent.id, 'EARNED stays (default)');
    assert.equal(paid.agentId, agentFrom.agent.id, 'PAID never touched');
  });

  test('includeEarnedKomisi=true transfers EARNED too', async (t) => {
    const tag = makeTag('xfer-earned');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agentFrom = await tempAgent(t, `${tag}-from`);
    const agentTo = await tempAgent(t, `${tag}-to`);

    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
        agentId: agentFrom.agent.id, agentSlugCap: agentFrom.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await db.komisi.create({
      data: { bookingId: booking.id, agentId: agentFrom.agent.id, amount: '60000', currency: 'IDR', status: 'EARNED', earnedAt: new Date() },
    });

    await transferBookingAgent({
      ...ctx, bookingId: booking.id, toAgentId: agentTo.agent.id,
      reason: 'admin opt-in transfer EARNED',
      includeEarnedKomisi: true,
    });
    const k = await db.komisi.findFirst({ where: { bookingId: booking.id } });
    assert.equal(k.agentId, agentTo.agent.id, 'EARNED moved via opt-in');
  });

  test('toAgentId=null transfers to Kantor Pusat + deletes PENDING komisi', async (t) => {
    const tag = makeTag('xfer-kp');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agentFrom = await tempAgent(t, tag);

    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id, jemaahUserId: user.id,
        agentId: agentFrom.agent.id, agentSlugCap: agentFrom.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await db.komisi.create({
      data: { bookingId: booking.id, agentId: agentFrom.agent.id, amount: '60000', currency: 'IDR', status: 'PENDING' },
    });

    const result = await transferBookingAgent({
      ...ctx, bookingId: booking.id, toAgentId: null,
      reason: 'transfer to Kantor Pusat',
    });
    assert.equal(result.booking.agentId, null, 'no agent on booking');
    assert.equal(result.booking.agentSlugCap, agentFrom.agent.slug, 'agentSlugCap STILL unchanged');

    const k = await db.komisi.findMany({ where: { bookingId: booking.id } });
    assert.equal(k.length, 0, 'PENDING komisi deleted (KP earns nothing)');
  });

  test('refuses on CANCELLED booking', async (t) => {
    const tag = makeTag('xfer-cancelled');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agent = await tempAgent(t, tag);
    const booking = await tempBooking({ paket, jemaahProfileId: user.jemaah.id, jemaahUserId: user.id });
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'pre-cancel' });

    await assert.rejects(
      transferBookingAgent({
        ...ctx, bookingId: booking.id, toAgentId: agent.agent.id, reason: 'too late',
      }),
      (err) => err.code === 'BOOKING_CLOSED',
    );
  });

  test('no-op when toAgentId equals current', async (t) => {
    const tag = makeTag('xfer-noop');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const agent = await tempAgent(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    const auditBefore = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    const result = await transferBookingAgent({
      ...ctx, bookingId: booking.id, toAgentId: agent.agent.id,
      reason: 'no change wanted',
    });
    // Service returns { booking, noop:true } on no-op path, vs the booking
    // directly on the real-transfer path. Accept either shape.
    assert.equal(result.noop, true, 'service signals noop');
    assert.equal(result.booking.agentId, agent.agent.id, 'agent unchanged');
    const auditAfter = await db.auditLog.count({
      where: { entity: 'Booking', entityId: booking.id, action: 'UPDATE' },
    });
    assert.equal(auditBefore, auditAfter, 'no-op transfer skips audit');
  });
});
