// Stage 194 — SEO + Open Graph helper for /p/:slug. Builds the
// title / description / canonical URL / OG image URL used by the
// landing page's <head> block.
//
// Description sanitisation: strip HTML tags, collapse whitespace,
// truncate to 160 chars (the social-card sweet spot — Twitter cuts
// around 200, Facebook around 300, but 160 keeps the preview clean).

const DESC_MAX = 160;
const DEFAULT_OG_IMAGE = '/shared/og-default.jpg';

/**
 * Build SEO metadata for a paket landing page.
 *
 * @param {object} paket — { title, subtitle, slug, durationDays, departureDate, heroDescription }
 * @param {object|null} agent — { slug } when an agent referral is active
 * @param {object} opts — { baseUrl, dateFormatter }
 * @returns {{ url, title, description, image, locale }}
 */
export function buildPaketSeo(paket, agent = null, {
  baseUrl = '', dateFormatter = (d) => d?.toISOString?.()?.slice(0, 10) ?? '',
} = {}) {
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : '';
  const path = `/p/${paket.slug}${agent && agent.slug ? `?a=${encodeURIComponent(agent.slug)}` : ''}`;
  const url = base ? base + path : path;

  const title = `${paket.title}${paket.subtitle ? ` · ${paket.subtitle}` : ''} — Religio Pro`;

  // Description: prefer heroDescription, fall back to a generic
  // line built from the trip facts.
  const rawDesc = paket.heroDescription
    || `Paket ${paket.title} bersama Religio Pro. Berangkat ${dateFormatter(paket.departureDate)}, ${paket.durationDays} hari.`;
  const description = sanitiseDescription(rawDesc);

  const image = base ? base + DEFAULT_OG_IMAGE : DEFAULT_OG_IMAGE;

  return { url, title, description, image, locale: 'id_ID' };
}

/**
 * Strip HTML, collapse whitespace, truncate. Exported for tests so
 * we can pin the behaviour.
 */
export function sanitiseDescription(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/<[^>]+>/g, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > DESC_MAX ? collapsed.slice(0, DESC_MAX) : collapsed;
}

export { DESC_MAX, DEFAULT_OG_IMAGE };
