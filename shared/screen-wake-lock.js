// Stage 365 — Screen Wake Lock helper for ibadah counters.
//
// Why this exists: Thawaf is 7 putaran (~25-40 minutes); Sa'i is 7 trips
// (~30 min). Phone screens sleep every 30s by default. Jemaah tapping
// every 5-10 minutes have to re-wake the screen each putaran, which
// breaks focus and risks losing count. The Screen Wake Lock API keeps
// the display on as long as the page is visible.
//
// Browser support:
//   - Chrome/Edge on Android/Desktop ≥ 84
//   - Safari ≥ 16.4 (iOS 16.4+)
//   - Older browsers: silently no-op (counter still works, just not lock-on)
//
// Lock auto-releases when:
//   - Page becomes hidden (tab switch, app background)
//   - User navigates away
//   - We explicitly call release()
//
// Re-acquires on visibilitychange when page returns to visible — so a
// jemaah who briefly switched apps comes back to a locked screen again.

(function (global) {
  let lock = null;
  let wanted = false; // user requested wake; if true we re-acquire on visibility

  async function acquire() {
    wanted = true;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return { ok: false, reason: 'unsupported' };
    }
    if (lock) return { ok: true, alreadyHeld: true };
    try {
      lock = await navigator.wakeLock.request('screen');
      // System can release the lock when page hidden — listen so we can
      // re-acquire on visible. Wake-lock spec emits a 'release' event.
      lock.addEventListener('release', () => {
        lock = null;
        // If user still wants it AND page is currently visible, re-acquire.
        // (When page becomes hidden the OS releases — we'll re-acquire on
        // visibilitychange below; nothing to do here.)
      });
      return { ok: true };
    } catch (err) {
      console.warn('[wake-lock] acquire failed:', err?.message || err);
      lock = null;
      return { ok: false, reason: 'denied' };
    }
  }

  async function release() {
    wanted = false;
    if (!lock) return;
    try { await lock.release(); } catch (_err) { /* silent */ }
    lock = null;
  }

  // Re-acquire on visibility return — OS auto-releases when page hidden,
  // so without this the lock would be permanently lost the first time
  // jemaah swaps apps mid-thawaf.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && wanted && !lock) {
        try {
          lock = await navigator.wakeLock.request('screen');
          lock.addEventListener('release', () => { lock = null; });
        } catch (_err) { /* page may have been closed before re-acquire */ }
      }
    });
  }

  global.ScreenWakeLock = { acquire, release };
})(typeof window !== 'undefined' ? window : globalThis);
