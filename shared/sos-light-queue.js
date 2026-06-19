// Stage 355 — IndexedDB-backed SOS-light queue.
//
// Why this exists: jemaah submit SOS from /saya when in-trip (S321). Saudi
// signal drops out in hotel basements / mountain passes / inside Masjidil
// Haram — a failed POST when signal is dead would silently lose the SOS.
// Queue locally, drain on `online` event + interval tick.
//
// The server endpoint (POST /api/saya/help-request) has a 30-min per-booking
// cooldown via the Notification table, so re-sending the same payload N times
// after a long-running outage is naturally idempotent — only the first reaches
// the admin desk; subsequent replays return ALREADY_PENDING and we just delete
// the queued row.
//
// Public API (window.SosLightQueue):
//   enqueue({ url, payload, label }) → Promise<id>
//   list() → Promise<Item[]>
//   countPending() → Promise<number>
//   drain({ onProgress }) → Promise<{ ok, failed }>
//   clear() → Promise<void>
//   startAutoFlush({ intervalMs, onChange }) → stopFn
//
// Each item:
//   { id, url, payload: { message }, label, createdAt,
//     attemptCount, lastAttemptAt, lastError, status }
// status ∈ { 'pending', 'syncing', 'failed' }

(function () {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    window.SosLightQueue = makeNoopQueue();
    return;
  }

  const DB_NAME = 'religio-sos-light';
  const DB_VERSION = 1;
  const STORE = 'queue';

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDb().then((db) => {
      const t = db.transaction(STORE, mode);
      return t.objectStore(STORE);
    });
  }

  function awaitReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueue({ url, payload, label }) {
    const store = await tx('readwrite');
    const item = {
      url, payload, label: label || null,
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      status: 'pending',
    };
    const id = await awaitReq(store.add(item));
    notifyChange();
    return id;
  }

  async function list() {
    const store = await tx('readonly');
    return await awaitReq(store.getAll());
  }

  async function countPending() {
    const store = await tx('readonly');
    const all = await awaitReq(store.getAll());
    return all.filter((it) => it.status !== 'done').length;
  }

  async function remove(id) {
    const store = await tx('readwrite');
    await awaitReq(store.delete(id));
  }

  async function updateItem(id, patch) {
    const store = await tx('readwrite');
    const cur = await awaitReq(store.get(id));
    if (!cur) return;
    Object.assign(cur, patch);
    await awaitReq(store.put(cur));
  }

  async function clear() {
    const store = await tx('readwrite');
    await awaitReq(store.clear());
    notifyChange();
  }

  let draining = false;
  async function drain({ onProgress } = {}) {
    if (draining) return { ok: 0, failed: 0, skipped: true };
    draining = true;
    let ok = 0;
    let failed = 0;
    try {
      const items = await list();
      const pending = items.filter((it) => it.status !== 'done');
      for (const item of pending) {
        await updateItem(item.id, { status: 'syncing' });
        onProgress?.({ item, phase: 'start' });
        try {
          // CSRF cookie auto-attached by shared/csrf.js fetch monkey-patch.
          const res = await fetch(item.url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.payload || {}),
          });
          const body = await res.json().catch(() => ({}));
          // ALREADY_PENDING (cooldown collision from replay) counts as success
          // for queue purposes — first delivery landed, this row is now dead.
          if (res.ok || body?.code === 'ALREADY_PENDING') {
            await remove(item.id);
            ok += 1;
            onProgress?.({ item, phase: 'ok' });
          } else {
            throw new Error(body?.message || 'HTTP ' + res.status);
          }
        } catch (err) {
          failed += 1;
          await updateItem(item.id, {
            status: 'failed',
            attemptCount: (item.attemptCount || 0) + 1,
            lastAttemptAt: new Date().toISOString(),
            lastError: String(err?.message || err),
          });
          onProgress?.({ item, phase: 'fail', error: err });
        }
      }
    } finally {
      draining = false;
      notifyChange();
    }
    return { ok, failed };
  }

  const listeners = new Set();
  function notifyChange() {
    for (const fn of listeners) {
      try { fn(); } catch { /* ignore listener throws */ }
    }
  }
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function startAutoFlush({ intervalMs = 30_000, onChange: onCh } = {}) {
    let stopped = false;
    let timer = null;
    const unsubChange = onCh ? onChange(onCh) : null;
    async function tick() {
      if (stopped) return;
      if (!navigator.onLine) return;
      const n = await countPending();
      if (n > 0) await drain();
    }
    const onlineHandler = () => tick();
    window.addEventListener('online', onlineHandler);
    timer = setInterval(tick, intervalMs);
    tick();
    return function stop() {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('online', onlineHandler);
      unsubChange?.();
    };
  }

  function makeNoopQueue() {
    return {
      enqueue: async () => { throw new Error('IndexedDB not available'); },
      list: async () => [],
      countPending: async () => 0,
      drain: async () => ({ ok: 0, failed: 0 }),
      clear: async () => {},
      startAutoFlush: () => () => {},
      onChange: () => () => {},
    };
  }

  window.SosLightQueue = {
    enqueue, list, countPending, drain, clear, onChange, startAutoFlush,
  };
})();
