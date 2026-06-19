// Stage 367 — Persistent Storage request helper.
//
// Chrome (+ Chromium-based browsers) can evict IndexedDB stores when
// device storage is low. Low-end Android phones (which a lot of jemaah
// use) hit storage pressure often. If the SOS queue (S355), ibadah
// counters (S328-330), or attendance queue (S5xx) get evicted mid-trip,
// that's loss of critical user data.
//
// Calling `navigator.storage.persist()` prompts the user (Chrome shows
// a permission card; Safari/Firefox grant silently based on heuristics)
// to mark the origin's storage as durable — protected from eviction
// until the user explicitly clears it.
//
// Browser support:
//   - Chrome/Edge ≥ 55, Firefox ≥ 57 — full support
//   - Safari ≥ 15.4 — partial (always grants for "installed" PWAs)
//   - Older browsers: navigator.storage undefined → silent no-op
//
// We call this ONCE per session per origin (localStorage flag) to avoid
// re-prompting users that already declined or already granted. Per-tab
// dedupe also prevents racing calls (e.g. two tabs hitting the same
// trigger surface within a second).
//
// API:
//   PersistStorage.request({reason}) → Promise<{ok, persisted, reason}>
//   PersistStorage.status() → Promise<{supported, persisted}>
//
// `reason` is a label like 'sos' / 'ibadah' / 'attendance' so future
// telemetry can answer "which surface triggered the durability ask".

(function (global) {
  const SESSION_FLAG = 'rp_persist_asked';

  async function status() {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persisted !== 'function') {
      return { supported: false, persisted: false };
    }
    try {
      const persisted = await navigator.storage.persisted();
      return { supported: true, persisted };
    } catch (_err) {
      return { supported: false, persisted: false };
    }
  }

  let pending = null; // single-flight guard across concurrent triggers in the same tab

  async function request({ reason } = {}) {
    if (pending) return pending;
    const run = (async () => {
      if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
        return { ok: false, persisted: false, reason: 'unsupported' };
      }
      // Already persisted? No-op.
      const cur = await status();
      if (cur.persisted) return { ok: true, persisted: true, reason: 'already_persisted' };
      // Asked-this-session? Don't spam. Note: this is a SESSION flag (sessionStorage
      // would also work but localStorage survives PWA cold-launch which is closer
      // to "same install session"). Cleared when user manually clears storage.
      try {
        if (localStorage.getItem(SESSION_FLAG) === '1') {
          return { ok: false, persisted: false, reason: 'already_asked_this_session' };
        }
      } catch (_e) { /* private mode → just attempt */ }
      try {
        localStorage.setItem(SESSION_FLAG, '1');
      } catch (_e) { /* private mode → continue */ }
      try {
        const granted = await navigator.storage.persist();
        return { ok: true, persisted: granted, reason: reason || 'requested' };
      } catch (err) {
        return { ok: false, persisted: false, reason: 'denied_or_error', error: String(err?.message || err) };
      }
    })();
    pending = run;
    try { return await run; } finally { pending = null; }
  }

  global.PersistStorage = { request, status };
})(typeof window !== 'undefined' ? window : globalThis);
