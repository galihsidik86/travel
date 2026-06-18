// Stage 336 — crew push routes + client script shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

test('S336 — push-crew.js mirrors push-jemaah.js DOM contract', async () => {
  const src = await fs.readFile('./shared/push-crew.js', 'utf8');
  // Same #rp-push-{bar,status,enable,disable} contract as jemaah
  assert.match(src, /rp-push-bar/);
  assert.match(src, /rp-push-status/);
  assert.match(src, /rp-push-enable/);
  assert.match(src, /rp-push-disable/);
  // Crew-specific endpoint paths (resolved at /crew/push/* after mount)
  assert.match(src, /\/crew\/push\/config/);
  assert.match(src, /\/crew\/push\/subscribe/);
  assert.match(src, /\/crew\/push\/unsubscribe/);
});

test('S336 — crew router exposes push endpoints', async () => {
  const src = await fs.readFile('./src/routes/crew.js', 'utf8');
  assert.match(src, /\/push\/config/);
  assert.match(src, /\/push\/subscribe/);
  assert.match(src, /\/push\/unsubscribe/);
  // Reuses role-agnostic webPush service (dynamic import inside handlers)
  assert.match(src, /\.\.\/services\/webPush\.js/);
});

test('S335 — jemaah-portal.ejs wires push CTA on Hari Ini hero', async () => {
  const src = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  assert.match(src, /rp-push-cta-hero/);
  assert.match(src, /Aktifkan notif tim/);
  // CTA only renders inside the inTrip conditional block
  assert.match(src, /Stage 335/);
});
