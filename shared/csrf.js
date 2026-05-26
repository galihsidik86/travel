// CSRF client helper — monkey-patches window.fetch to auto-attach the
// X-CSRF-Token header on state-changing requests. Pairs with the server-side
// double-submit cookie middleware (src/middleware/csrf.js).
//
// Load this script BEFORE any inline JS that uses fetch().
(function () {
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    const method = (init.method
      || (input && typeof input !== 'string' && input.method)
      || 'GET').toUpperCase();
    if (STATE_CHANGING.has(method)) {
      const token = getCookie('rp_csrf');
      if (token) {
        // Don't clobber if the caller already set a value
        const existing = init.headers || {};
        const has = (existing instanceof Headers)
          ? existing.has('X-CSRF-Token')
          : Object.keys(existing).some((k) => k.toLowerCase() === 'x-csrf-token');
        if (!has) {
          if (existing instanceof Headers) {
            existing.set('X-CSRF-Token', token);
            init.headers = existing;
          } else {
            init.headers = { ...existing, 'X-CSRF-Token': token };
          }
        }
      }
    }
    return originalFetch(input, init);
  };
})();
