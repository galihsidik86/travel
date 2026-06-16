// Stage 304 + S305 — per-agent cancel + refund reason rollup tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import {
  getAgentCancelRefundReasons, CANCEL_LABELS, REFUND_LABELS,
} from '../src/services/agentCancelRefundReasons.js';

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-ag@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { slug: `${tag}-slug`, displayName: `Agen ${tag}`, whatsapp: '+62811', tier: 'BRONZE' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('S304 — empty envelope when no agentId', async () => {
  const r = await getAgentCancelRefundReasons({ agentId: null });
  assert.equal(r.cancel.total, 0);
  assert.equal(r.refund.total, 0);
  assert.deepEqual(r.cancel.rows, []);
  assert.deepEqual(r.refund.rows, []);
});

test('S304 — groups cancel reasons + computes sharePct + sorts desc', async (t) => {
  const tag = makeTag('s304');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);
  const now = new Date();

  // 4 cancels: 2 PAYMENT_NOT_RECEIVED, 1 DOCUMENT_INCOMPLETE, 1 unset.
  for (const code of ['PAYMENT_NOT_RECEIVED', 'PAYMENT_NOT_RECEIVED', 'DOCUMENT_INCOMPLETE', null]) {
    await db.booking.create({
      data: {
        bookingNo: `RP-S304-${Math.random().toString(36).slice(2, 8)}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '500000',
        status: 'CANCELLED', cancelledAt: now, cancelReasonCode: code,
      },
    });
  }

  const r = await getAgentCancelRefundReasons({ agentId: agen.agent.id });
  assert.equal(r.cancel.total, 4);
  assert.equal(r.cancel.rows[0].code, 'PAYMENT_NOT_RECEIVED');
  assert.equal(r.cancel.rows[0].count, 2);
  assert.equal(r.cancel.rows[0].sharePct, 50);
  assert.equal(r.cancel.rows[1].code, 'DOCUMENT_INCOMPLETE');
  // __UNSET__ always last
  assert.equal(r.cancel.rows[r.cancel.rows.length - 1].code, '__UNSET__');
});

test('S305 — groups refund reasons by IDR sum', async (t) => {
  const tag = makeTag('s305');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  const b = await db.booking.create({
    data: {
      bookingNo: `RP-S305-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0',
      status: 'CANCELLED', cancelledAt: new Date(),
    },
  });
  // 2 refund rows: a big VISA_REJECTED + a small GOODWILL.
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '-500000', currency: 'IDR',
      method: 'TRANSFER', status: 'REFUNDED', refundReasonCode: 'VISA_REJECTED',
    },
  });
  await db.payment.create({
    data: {
      bookingId: b.id, amount: '-100000', currency: 'IDR',
      method: 'TRANSFER', status: 'REFUNDED', refundReasonCode: 'GOODWILL',
    },
  });

  const r = await getAgentCancelRefundReasons({ agentId: agen.agent.id });
  assert.equal(r.refund.total, 2);
  assert.equal(r.refund.totalIdr, 600000);
  // Larger refund first
  assert.equal(r.refund.rows[0].code, 'VISA_REJECTED');
  assert.equal(r.refund.rows[0].refundedIdr, 500000);
  assert.ok(r.refund.rows[0].sharePct > 80);
});

test('S304 — labels expose the expected Bahasa text', () => {
  assert.equal(CANCEL_LABELS.PAYMENT_NOT_RECEIVED, 'Pembayaran tidak masuk');
  assert.equal(REFUND_LABELS.VISA_REJECTED, 'Visa ditolak');
  assert.equal(CANCEL_LABELS.__UNSET__, 'Belum dikategorikan');
});
