// Stage 25 — friendly activity-feed formatter.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { formatAuditEntry, formatRecentActivity } from '../src/lib/auditFormat.js';

function row(over = {}) {
  return {
    id: 'log_' + Math.random().toString(36).slice(2, 8),
    createdAt: new Date(),
    actorEmail: 'owner@religio.pro',
    actorRole: 'OWNER',
    entity: 'Booking', action: 'CREATE',
    entityId: 'cmpxxxx0000111222333',
    after: {}, before: {},
    ...over,
  };
}

describe('formatAuditEntry — Booking', () => {
  test('CREATE → "Booking baru <bookingNo>"', () => {
    const r = formatAuditEntry(row({ after: { bookingNo: 'RP-2026-00012' } }));
    assert.match(r.sentence, /Booking baru RP-2026-00012/);
    assert.equal(r.badge, 'CREATE');
    assert.match(r.url, /^\/admin\/bookings\//);
  });

  test('admin walk-in booking labelled differently', () => {
    const r = formatAuditEntry(row({ after: { bookingNo: 'RP-2026-00015', adminCreated: true } }));
    assert.match(r.sentence, /Walk-in booking/);
  });

  test('STATUS_CHANGE to CANCELLED → cancel sentence + CANCEL badge', () => {
    const r = formatAuditEntry(row({
      action: 'STATUS_CHANGE',
      after: { bookingNo: 'RP-2026-00020', status: 'CANCELLED' },
    }));
    assert.match(r.sentence, /dibatalkan/);
    assert.equal(r.badge, 'CANCEL');
  });

  test('refund full → REFUND badge', () => {
    const r = formatAuditEntry(row({
      action: 'STATUS_CHANGE',
      after: { bookingNo: 'RP-2026-00020', status: 'REFUNDED' },
    }));
    assert.match(r.sentence, /refund/i);
    assert.equal(r.badge, 'REFUND');
  });

  test('transfer agen → TRANSFER badge + sentence', () => {
    const r = formatAuditEntry(row({
      action: 'UPDATE',
      after: { bookingNo: 'RP-2026-00012', transfer: true },
    }));
    assert.match(r.sentence, /transfer/i);
    assert.equal(r.badge, 'TRANSFER');
  });

  test('claim merge → CLAIM badge', () => {
    const r = formatAuditEntry(row({
      action: 'UPDATE',
      after: { bookingNo: 'RP-2026-00012', merged: true, targetJemaahId: 'x' },
    }));
    assert.match(r.sentence, /klaim/i);
    assert.equal(r.badge, 'CLAIM');
  });
});

describe('formatAuditEntry — Payment / Payout / Komisi', () => {
  test('KomisiPayout reports amount + deep-link', () => {
    const r = formatAuditEntry(row({
      entity: 'KomisiPayout', action: 'UPDATE',
      after: { payoutNo: 'PO-2026-00003', amount: 2_500_000 },
    }));
    assert.match(r.sentence, /PO-2026-00003/);
    assert.match(r.sentence, /Rp 2\.500\.000/);
    assert.equal(r.badge, 'PAYOUT');
    assert.equal(r.amountIdr, 2_500_000);
    assert.match(r.url, /^\/admin\/payouts\//);
  });

  test('Komisi state-change carries amount', () => {
    const r = formatAuditEntry(row({
      entity: 'Komisi', action: 'STATUS_CHANGE',
      after: { amount: 600_000, status: 'EARNED' },
    }));
    assert.equal(r.badge, 'KOMISI');
    assert.equal(r.amountIdr, 600_000);
  });
});

describe('formatAuditEntry — User', () => {
  test('LOGIN/LOGOUT sentences', () => {
    const lin = formatAuditEntry(row({ entity: 'User', action: 'LOGIN', actorEmail: 'a@b.c' }));
    assert.match(lin.sentence, /Login a@b\.c/);
    assert.equal(lin.badge, 'LOGIN');
    const lout = formatAuditEntry(row({ entity: 'User', action: 'LOGOUT', actorEmail: 'a@b.c' }));
    assert.match(lout.sentence, /Logout a@b\.c/);
    assert.equal(lout.badge, 'LOGOUT');
  });

  test('User CREATE links to user edit + reports email + role', () => {
    const r = formatAuditEntry(row({
      entity: 'User', action: 'CREATE',
      after: { email: 'kasir@religio.pro', role: 'KASIR' },
    }));
    assert.match(r.sentence, /User baru/);
    assert.match(r.sentence, /kasir@religio\.pro/);
    assert.match(r.sentence, /KASIR/);
    assert.match(r.url, /\/admin\/users\//);
  });
});

describe('formatAuditEntry — Incident', () => {
  test('CREATE SOS → SOS badge', () => {
    const r = formatAuditEntry(row({
      entity: 'Incident', action: 'CREATE',
      after: { type: 'SOS' },
    }));
    assert.match(r.sentence, /SOS/);
    assert.equal(r.badge, 'SOS');
    assert.match(r.url, /\/admin\/incidents\//);
  });

  test('STATUS_CHANGE → ACK / RESOLVE badge', () => {
    const ack = formatAuditEntry(row({
      entity: 'Incident', action: 'STATUS_CHANGE',
      after: { status: 'ACKED' },
    }));
    assert.equal(ack.badge, 'ACK');
    const res = formatAuditEntry(row({
      entity: 'Incident', action: 'STATUS_CHANGE',
      after: { status: 'RESOLVED' },
    }));
    assert.equal(res.badge, 'RESOLVE');
  });
});

describe('formatAuditEntry — JemaahDocument', () => {
  test('VERIFIED → VERIFY badge', () => {
    const r = formatAuditEntry(row({
      entity: 'JemaahDocument', action: 'UPDATE',
      after: { jemaahId: 'jem1', type: 'PASSPORT', status: 'VERIFIED' },
    }));
    assert.equal(r.badge, 'VERIFY');
    assert.match(r.url, /\/admin\/jemaah\/jem1\/edit$/);
  });

  test('autoExpired flag → EXPIRE badge', () => {
    const r = formatAuditEntry(row({
      entity: 'JemaahDocument', action: 'STATUS_CHANGE',
      after: { jemaahId: 'jem1', type: 'PASSPORT', status: 'EXPIRED', autoExpired: true },
    }));
    assert.equal(r.badge, 'EXPIRE');
  });
});

describe('formatAuditEntry — Paket clone + Retention', () => {
  test('Paket CREATE with cloned flag → CLONE badge', () => {
    const r = formatAuditEntry(row({
      entity: 'Paket', action: 'CREATE',
      after: { slug: 'ramadhan-2027', cloned: true, clonedFromSlug: 'ramadhan-2026' },
    }));
    assert.equal(r.badge, 'CLONE');
    assert.match(r.sentence, /ramadhan-2026/);
  });

  test('Retention sweep → PRUNE badge', () => {
    const r = formatAuditEntry(row({
      entity: 'Retention', action: 'DELETE', entityId: '2026-06-05',
    }));
    assert.equal(r.badge, 'PRUNE');
  });
});

describe('formatRecentActivity batch', () => {
  test('preserves order + emits the new shape', () => {
    const rows = [
      row({ entity: 'User', action: 'LOGIN' }),
      row({ entity: 'Booking', action: 'CREATE', after: { bookingNo: 'X' } }),
    ];
    const out = formatRecentActivity(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].badge, 'LOGIN');
    assert.equal(out[1].badge, 'CREATE');
    assert.ok('sentence' in out[0] && 'url' in out[0] && 'amountIdr' in out[0]);
  });
});
