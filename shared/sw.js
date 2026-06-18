// Religio Pro — minimal service worker.
//
// Strategy:
//   - Static assets (CSS/JS/SVG/font CSS) — cache-first with background refresh
//   - Same-origin HTML pages — network-first, fall back to last-seen cache, then offline page
//   - Everything else (cross-origin, API POST etc.) — passthrough (no caching)
//
// We deliberately do NOT cache /api/* responses: they include CSRF cookies + per-user
// data, and a stale cached response would be confusing on a queue/balance screen.
//
// Cache busting: bump CACHE_VERSION to invalidate every entry on next activation.

const CACHE_VERSION = 'rp-v5';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const HTML_CACHE = `${CACHE_VERSION}-html`;
// Stage 334 — cap HTML cache to prevent unbounded growth in long-running
// PWA sessions. Eviction is FIFO (oldest entry first) when we exceed cap.
const HTML_CACHE_MAX = 50;
// Stage 334 — paths that get stale-while-revalidate (cache served first,
// network refreshes in background). Critical for Saudi where signal is
// flaky — network-first wait would make pages feel slow. Falls back to
// network-first for other HTML paths (admin/crew where freshness matters).
const SWR_PATH_PREFIXES = ['/saya/bookings/', '/saya/ibadah'];

const PRECACHE_URLS = [
  '/shared/tokens.css',
  '/shared/csrf.js',
  '/shared/pwa.js',
  '/shared/attendance-queue.js',
  '/shared/icon.svg',
  '/shared/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Best-effort: skip any URL that fails (e.g. dev where one is missing).
      await Promise.all(
        PRECACHE_URLS.map((u) => cache.add(u).catch(() => null)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith('/shared/')
    || url.pathname.startsWith('/uploads/')
    || /\.(?:css|js|svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(url.pathname);
}

function isHtmlGet(req, url) {
  if (req.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/private/')) return false;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

// Stage 334 — HTML cache cap eviction. cache.keys() returns entries in
// insertion order; deleting the first N until we're back under HTML_CACHE_MAX
// is a passable FIFO approximation of LRU (true LRU would need timestamp
// tracking per entry).
async function capHtmlCache() {
  try {
    const cache = await caches.open(HTML_CACHE);
    const keys = await cache.keys();
    if (keys.length <= HTML_CACHE_MAX) return;
    const overflow = keys.length - HTML_CACHE_MAX;
    for (let i = 0; i < overflow; i++) {
      await cache.delete(keys[i]);
    }
  } catch (_err) { /* silent — cache eviction is best-effort */ }
}

// Stage 334 — network-first with cache fallback (default for admin/crew
// HTML where freshness matters more than speed). Falls back to offline
// page when both network and cache miss.
async function handleNetworkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(HTML_CACHE);
      await cache.put(req, res.clone());
      capHtmlCache(); // fire-and-forget
    }
    return res;
  } catch (_err) {
    const cache = await caches.open(HTML_CACHE);
    const cached = await cache.match(req);
    if (cached) return tagCached(cached);
    const offline = await caches.match('/shared/offline.html');
    return offline || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// Stage 334 — stale-while-revalidate: return cache immediately (snappy),
// refresh in background. Used for /saya/bookings/ + /saya/ibadah where
// jemaah in flaky Saudi signal benefit from instant render. Cache-miss
// falls through to network-first.
async function handleSwr(req) {
  const cache = await caches.open(HTML_CACHE);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) {
        cache.put(req, res.clone());
        capHtmlCache();
      }
      return res;
    })
    .catch(() => null);
  if (cached) {
    // Don't await refresh — let it run in background. Returns immediately.
    refresh.catch(() => {});
    return tagCached(cached);
  }
  // No cache yet — fall through to network with offline fallback.
  const res = await refresh;
  if (res) return res;
  const offline = await caches.match('/shared/offline.html');
  return offline || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

// Stage 334 — annotate cache-served responses with a header so client
// JS can show a small "offline mode" indicator if desired. Headers on
// cached Responses are read-only — clone with mutable Headers.
function tagCached(res) {
  const headers = new Headers(res.headers);
  headers.set('X-SW-Cache', 'hit');
  return new Response(res.body, {
    status: res.status, statusText: res.statusText, headers,
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const req = event.request;

  // Static assets — cache-first, refresh in background.
  if (isStaticAsset(url) && req.method === 'GET') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        const fetchAndStore = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await fetchAndStore) || new Response('', { status: 504 });
      })(),
    );
    return;
  }

  // HTML pages — network-first by default, stale-while-revalidate for
  // /saya/bookings/ + /saya/ibadah (S334) where snappy response under
  // flaky signal matters more than freshness.
  if (isHtmlGet(req, url)) {
    const useSwr = SWR_PATH_PREFIXES.some((p) => url.pathname.startsWith(p));
    event.respondWith(
      useSwr
        ? handleSwr(req)
        : handleNetworkFirst(req),
    );
    return;
  }

  // Everything else (API, POSTs, cross-origin): passthrough — no SW involvement.
});

// ── Web Push (stage 17) ─────────────────────────────────────────────
// Payload from server (webPush.pushToAdmins):
//   { title, body, url, tag?, icon? }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() ?? '' }; }
  const title = data.title || 'Religio Pro';
  const body = data.body || '';
  const url = data.url || '/admin/incidents';
  const tag = data.tag || 'rp-incident';
  const icon = data.icon || '/shared/icon.svg';
  event.waitUntil(
    self.registration.showNotification(title, {
      body, icon, tag,
      badge: '/shared/icon.svg',
      data: { url },
      requireInteraction: data.requireInteraction === true,
    }),
  );
});

// Click → focus existing tab on the target URL, or open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/admin/incidents';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      // Same-origin match by path prefix — focus + navigate if needed.
      const cUrl = new URL(c.url);
      if (cUrl.origin === self.location.origin) {
        await c.focus();
        if (!c.url.endsWith(url) && 'navigate' in c) {
          try { await c.navigate(url); } catch { /* some platforms forbid */ }
        }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
