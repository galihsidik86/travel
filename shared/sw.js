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

const CACHE_VERSION = 'rp-v4';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const HTML_CACHE = `${CACHE_VERSION}-html`;

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

  // HTML pages — network-first, cache fallback, offline page last.
  if (isHtmlGet(req, url)) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(HTML_CACHE);
            cache.put(req, res.clone());
          }
          return res;
        } catch (_err) {
          const cache = await caches.open(HTML_CACHE);
          const cached = await cache.match(req);
          if (cached) return cached;
          const offline = await caches.match('/shared/offline.html');
          return offline || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
      })(),
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
