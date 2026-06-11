// Stage 194 — SEO + Open Graph metadata builder for /p/:slug.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaketSeo, sanitiseDescription,
  DESC_MAX, DEFAULT_OG_IMAGE,
} from '../src/services/paketSeo.js';

test('exported constants sane', () => {
  assert.equal(DESC_MAX, 160);
  assert.equal(DEFAULT_OG_IMAGE, '/shared/og-default.jpg');
});

test('sanitiseDescription: strips HTML tags', () => {
  const out = sanitiseDescription('<p>Hello <em>world</em></p>');
  assert.equal(out, 'Hello world');
});

test('sanitiseDescription: collapses whitespace', () => {
  const out = sanitiseDescription('a  b\n\tc');
  assert.equal(out, 'a b c');
});

test('sanitiseDescription: truncates to 160 chars', () => {
  const long = 'x'.repeat(300);
  const out = sanitiseDescription(long);
  assert.equal(out.length, 160);
});

test('sanitiseDescription: empty/null → empty string', () => {
  assert.equal(sanitiseDescription(null), '');
  assert.equal(sanitiseDescription(''), '');
});

test('buildPaketSeo: basic shape with no agent + no baseUrl', () => {
  const seo = buildPaketSeo(
    { title: 'Ramadhan 2026', slug: 'ramadhan-2026', durationDays: 12, departureDate: new Date('2026-03-01') },
    null,
    {},
  );
  assert.equal(seo.title, 'Ramadhan 2026 — Religio Pro');
  assert.equal(seo.url, '/p/ramadhan-2026', 'relative URL when no baseUrl');
  assert.equal(seo.image, '/shared/og-default.jpg');
  assert.equal(seo.locale, 'id_ID');
  assert.match(seo.description, /Ramadhan 2026/);
  assert.match(seo.description, /12 hari/);
});

test('buildPaketSeo: subtitle appended to title', () => {
  const seo = buildPaketSeo(
    { title: 'Ramadhan 2026', subtitle: 'VVIP', slug: 'r26', durationDays: 10 },
    null, {},
  );
  assert.equal(seo.title, 'Ramadhan 2026 · VVIP — Religio Pro');
});

test('buildPaketSeo: agent slug → ?a= query param', () => {
  const seo = buildPaketSeo(
    { title: 'X', slug: 'x', durationDays: 10 },
    { slug: 'ahmad-w' },
    { baseUrl: 'https://religio.pro' },
  );
  assert.equal(seo.url, 'https://religio.pro/p/x?a=ahmad-w');
});

test('buildPaketSeo: baseUrl trims trailing slash', () => {
  const seo = buildPaketSeo(
    { title: 'X', slug: 'x', durationDays: 10 },
    null,
    { baseUrl: 'https://religio.pro/' },
  );
  assert.equal(seo.url, 'https://religio.pro/p/x');
  assert.equal(seo.image, 'https://religio.pro/shared/og-default.jpg');
});

test('buildPaketSeo: heroDescription preferred over generic fallback', () => {
  const seo = buildPaketSeo(
    {
      title: 'X', slug: 'x', durationDays: 10,
      heroDescription: '<p>Pengalaman umroh terbaik bersama tim experienced.</p>',
    },
    null, {},
  );
  assert.equal(seo.description, 'Pengalaman umroh terbaik bersama tim experienced.');
});

test('buildPaketSeo: long heroDescription truncated', () => {
  const seo = buildPaketSeo(
    {
      title: 'X', slug: 'x', durationDays: 10,
      heroDescription: 'x'.repeat(500),
    },
    null, {},
  );
  assert.equal(seo.description.length, 160);
});

test('buildPaketSeo: agent slug with special chars is URL-encoded', () => {
  const seo = buildPaketSeo(
    { title: 'X', slug: 'x', durationDays: 10 },
    { slug: 'agent/with/slash' },
    { baseUrl: 'https://r.pro' },
  );
  assert.match(seo.url, /a=agent%2Fwith%2Fslash/);
});
