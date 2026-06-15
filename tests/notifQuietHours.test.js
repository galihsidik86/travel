// Stage 298 — quiet hours gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateQuietHours,
  inQuietWindow,
  hourInTz,
  nextWindowOpen,
  URGENT_TYPES,
} from '../src/services/notifQuietHours.js';

// ── inQuietWindow ──────────────────────────────────────────────

test('inQuietWindow: non-wrap window (9 AM – 5 PM)', () => {
  assert.equal(inQuietWindow(8, 9, 17), false);
  assert.equal(inQuietWindow(9, 9, 17), true);
  assert.equal(inQuietWindow(12, 9, 17), true);
  assert.equal(inQuietWindow(16, 9, 17), true);
  assert.equal(inQuietWindow(17, 9, 17), false);
  assert.equal(inQuietWindow(20, 9, 17), false);
});

test('inQuietWindow: wraps midnight (21 PM – 7 AM)', () => {
  assert.equal(inQuietWindow(20, 21, 7), false);
  assert.equal(inQuietWindow(21, 21, 7), true);
  assert.equal(inQuietWindow(23, 21, 7), true);
  assert.equal(inQuietWindow(0, 21, 7), true);
  assert.equal(inQuietWindow(6, 21, 7), true);
  assert.equal(inQuietWindow(7, 21, 7), false);
  assert.equal(inQuietWindow(12, 21, 7), false);
});

test('inQuietWindow: empty window (start === end)', () => {
  assert.equal(inQuietWindow(0, 12, 12), false);
  assert.equal(inQuietWindow(12, 12, 12), false);
});

// ── hourInTz ───────────────────────────────────────────────────

test('hourInTz: returns 0-23 hour in TZ', () => {
  // 2026-06-15T03:00:00Z = 10:00 Jakarta (UTC+7)
  const d = new Date('2026-06-15T03:00:00Z');
  const h = hourInTz(d, 'Asia/Jakarta');
  assert.equal(h, 10);
});

test('hourInTz: invalid TZ falls back to local', () => {
  const d = new Date('2026-06-15T03:00:00Z');
  const h = hourInTz(d, 'Not/A_Zone');
  // Falls back to local — just verify it returns a valid hour (not NaN)
  assert.ok(Number.isFinite(h) && h >= 0 && h < 24);
});

// ── evaluateQuietHours ─────────────────────────────────────────

test('evaluateQuietHours: EMAIL channel never deferred', () => {
  const notif = {
    channel: 'EMAIL', type: 'PAYMENT_REMINDER',
    recipientUserId: 'user1',
  };
  // 3 AM Jakarta
  const at3am = new Date('2026-06-15T20:00:00Z'); // = 03:00 next day Jakarta
  const r = evaluateQuietHours(notif, { now: at3am });
  assert.equal(r.defer, false);
});

test('evaluateQuietHours: WA outside window NOT deferred', () => {
  const notif = {
    channel: 'WA', type: 'PAYMENT_REMINDER',
    recipientUserId: 'user1',
  };
  // 10 AM Jakarta = 03:00 UTC
  const at10am = new Date('2026-06-15T03:00:00Z');
  const r = evaluateQuietHours(notif, { now: at10am });
  assert.equal(r.defer, false);
});

test('evaluateQuietHours: WA inside window IS deferred', () => {
  const notif = {
    channel: 'WA', type: 'PAYMENT_REMINDER',
    recipientUserId: 'user1',
  };
  // 3 AM Jakarta = 20:00 prev day UTC
  const at3am = new Date('2026-06-14T20:00:00Z');
  const r = evaluateQuietHours(notif, { now: at3am });
  assert.equal(r.defer, true);
  assert.ok(r.deferUntil instanceof Date);
  assert.ok(r.deferUntil.getTime() > at3am.getTime());
});

test('evaluateQuietHours: urgent type bypasses gate even inside window', () => {
  for (const type of URGENT_TYPES) {
    const notif = { channel: 'WA', type, recipientUserId: 'user1' };
    const at3am = new Date('2026-06-14T20:00:00Z');
    const r = evaluateQuietHours(notif, { now: at3am });
    assert.equal(r.defer, false, `URGENT type ${type} should bypass`);
  }
});

test('evaluateQuietHours: admin-targeted (no recipientUserId) bypasses gate', () => {
  const notif = {
    channel: 'WA', type: 'PAYMENT_REMINDER',
    recipientUserId: null,
  };
  const at3am = new Date('2026-06-14T20:00:00Z');
  const r = evaluateQuietHours(notif, { now: at3am });
  assert.equal(r.defer, false);
});

// ── nextWindowOpen ─────────────────────────────────────────────

test('nextWindowOpen: returns a future Date outside the window', () => {
  const at3am = new Date('2026-06-14T20:00:00Z'); // 03:00 Jakarta
  const next = nextWindowOpen(at3am, { start: 21, end: 7, tz: 'Asia/Jakarta' });
  assert.ok(next.getTime() > at3am.getTime());
  // Verify the resulting hour is outside the quiet window
  const nextHour = hourInTz(next, 'Asia/Jakarta');
  assert.equal(inQuietWindow(nextHour, 21, 7), false, 'returned time must be outside window');
});

test('nextWindowOpen: rounded to top of hour', () => {
  const at3am = new Date('2026-06-14T20:33:45Z');
  const next = nextWindowOpen(at3am, { start: 21, end: 7, tz: 'Asia/Jakarta' });
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getSeconds(), 0);
});
