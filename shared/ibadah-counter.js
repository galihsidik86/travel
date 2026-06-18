// Stage 328-330 — minimal IndexedDB-backed counter for Thawaf + Sa'i.
//
// Single object store `state` keyed by counter id ('thawaf' | 'sai').
// Each row: `{id, putaran, lastTapAt, completedAt|null, startedAt|null}`.
//
// Why IDB and not localStorage: jemaah may have the PWA installed +
// app reload mid-thawaf; IDB survives that more reliably and gives a
// clean async API for future expansion (e.g. per-trip history).
//
// All ops resolve to `null` on storage failure rather than throw — the
// counter must keep working even when storage is unavailable (in-memory
// fallback).

(function (global) {
  const DB_NAME = 'religio-ibadah';
  const STORE = 'state';
  const VERSION = 1;

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { console.warn('[ibadah] IDB open failed', req.error); resolve(null); };
      } catch (err) {
        console.warn('[ibadah] IDB unsupported', err);
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function readState(id) {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (err) { resolve(null); }
    });
  }

  async function writeState(state) {
    const db = await openDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(state);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) { resolve(false); }
    });
  }

  async function getCounter(id) {
    const row = await readState(id);
    return row || { id, putaran: 0, lastTapAt: null, startedAt: null, completedAt: null };
  }

  async function tap(id, { max = 7 } = {}) {
    const s = await getCounter(id);
    if (s.putaran >= max) return s; // already complete
    const now = new Date().toISOString();
    s.putaran += 1;
    s.lastTapAt = now;
    if (!s.startedAt) s.startedAt = now;
    if (s.putaran === max) s.completedAt = now;
    await writeState(s);
    return s;
  }

  async function reset(id) {
    const fresh = { id, putaran: 0, lastTapAt: null, startedAt: null, completedAt: null };
    await writeState(fresh);
    return fresh;
  }

  async function undo(id) {
    const s = await getCounter(id);
    if (s.putaran <= 0) return s;
    s.putaran -= 1;
    if (s.putaran === 0) {
      s.startedAt = null;
      s.lastTapAt = null;
    }
    s.completedAt = null;
    await writeState(s);
    return s;
  }

  global.IbadahCounter = { getCounter, tap, reset, undo };
})(window);
