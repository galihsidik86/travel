// Religio Pro — IndexedDB-backed attendance queue.
//
// Why this exists: muthawwif (crew) mark attendance from a phone in a bus or
// on a mountain pass where signal is unreliable. A failed POST shouldn't lose
// the mark — queue it locally, replay when online.
//
// The server endpoint (POST /crew/paket/:slug/attendance/:dayId/:bookingId)
// is a Prisma upsert keyed on (dayId, bookingId), so re-sending the same
// payload N times leaves the DB in the same state as sending it once. That
// idempotency is why this queue can be naive — no dedup, no merge logic.
//
// Public API (window.AttendanceQueue):
//   enqueue({ url, payload, label }) → Promise<id>
//   list() → Promise<Item[]>
//   countPending() → Promise<number>
//   drain({ onProgress }) → Promise<{ ok: number, failed: number }>
//   clear() → Promise<void>
//   startAutoFlush({ intervalMs, onChange }) → stopFn
//
// Each item:
//   { id, url, payload: { _csrf, present, notes }, label, createdAt,
//     attemptCount, lastAttemptAt, lastError, status }
// status ∈ { 'pending', 'syncing', 'failed' }

(function () {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    // Graceful no-op: pages that import this still load on ancient browsers,
    // they just can't queue offline (network errors become hard failures).
    window.AttendanceQueue = makeNoopQueue();
    return;
  }

  const DB_NAME = 'religio-attendance';
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

  // Single in-flight drain at a time; concurrent invocations short-circuit.
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
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(item.payload || {})) form.append(k, v ?? '');
          const res = await fetch(item.url, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'follow',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form,
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await remove(item.id);
          ok += 1;
          onProgress?.({ item, phase: 'ok' });
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

  // ── Change notifier so UI can subscribe and refresh badges. ──────
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

  // ── Auto-flush: drain on online + on interval. ────────────────────
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
    // First tick — replay anything left behind from a previous session.
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

  window.AttendanceQueue = {
    enqueue, list, countPending, drain, clear, onChange, startAutoFlush,
  };
})();
