// Religio Pro — PWA bootstrap script.
//
// Loaded from every jemaah/crew layout. Registers the service worker and
// surfaces the install prompt as a one-shot UI affordance.

(function () {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // Service worker registration is best-effort — never block page render.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/shared/sw.js', { scope: '/' })
      .catch((err) => {
        // Dev: SW often fails on http://localhost without https — log quietly.
        console.warn('[pwa] sw register failed:', err.message);
      });
  });

  // Stage 360 — install funnel telemetry. Fire-and-forget POST to
  // /api/pwa/install-event. CSRF token auto-attached by shared/csrf.js
  // fetch monkey-patch. Failures swallowed silently (telemetry never
  // breaks the page). Path kind derived from URL prefix so admin can
  // slice by surface: /saya = jemaah, /crew = crew, /admin = admin,
  // anything else (including /p/:slug) = public.
  function pathKind() {
    const p = window.location.pathname || '';
    if (p.startsWith('/saya')) return 'jemaah';
    if (p.startsWith('/crew')) return 'crew';
    if (p.startsWith('/admin')) return 'admin';
    if (p.startsWith('/agen')) return 'agen';
    return 'public';
  }
  function trackInstallEvent(event) {
    try {
      fetch('/api/pwa/install-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, kind: pathKind() }),
        credentials: 'same-origin',
        keepalive: true, // survive page unload (e.g. when fired from beforeinstallprompt then user navigates)
      }).catch(() => { /* silent — telemetry must not break UX */ });
    } catch (_err) { /* fetch construction failed somehow — silent */ }
  }

  // Capture the install prompt so we can fire it from a user gesture later.
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.body.dataset.pwaInstallable = '1';
    trackInstallEvent('PROMPT_SHOWN'); // S360
  });

  // Expose a tiny API so any view can wire a "Pasang aplikasi" button:
  //   <button data-pwa-install>Pasang aplikasi</button>
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-pwa-install]');
    if (!btn) return;
    ev.preventDefault();
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    delete document.body.dataset.pwaInstallable;
    // S360 — funnel completion. choice.outcome is 'accepted' or 'dismissed'.
    trackInstallEvent(choice?.outcome === 'accepted' ? 'PROMPT_ACCEPTED' : 'PROMPT_DISMISSED');
    btn.dispatchEvent(new CustomEvent('pwa:choice', { bubbles: true, detail: choice }));
  });

  // Auto-hide install affordances after the app is already installed.
  window.addEventListener('appinstalled', () => {
    delete document.body.dataset.pwaInstallable;
    trackInstallEvent('INSTALLED'); // S360 — confirms install actually completed
  });

  // ── iOS install hint ─────────────────────────────────────────────
  // iOS Safari does NOT fire beforeinstallprompt — installation is
  // manual: Share → Add to Home Screen. Show a one-shot dismissable
  // hint at the bottom of the viewport so users actually discover it.
  //
  // Suppression rules:
  //   - Not iOS (Android/Desktop) → never show
  //   - In-app browser (FB/IG/CriOS/FxiOS) → never show (Share menu may
  //     differ or be missing; instructions wouldn't help)
  //   - Already running as installed app (standalone) → never show
  //   - User dismissed earlier (localStorage flag) → never show
  function shouldShowIosHint() {
    const ua = navigator.userAgent || '';
    const isIos = /iphone|ipad|ipod/i.test(ua)
      // iPad on iPadOS 13+ identifies as MacIntel — fall back to touch + Apple platform
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIos) return false;
    if (/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line/i.test(ua)) return false;
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isStandalone) return false;
    try {
      if (localStorage.getItem('rp_ios_install_hint_dismissed') === '1') return false;
    } catch { /* private mode → just show it */ }
    return true;
  }

  function injectIosHint() {
    if (document.getElementById('rp-ios-hint')) return;

    const style = document.createElement('style');
    style.textContent = `
      #rp-ios-hint {
        position: fixed; left: 12px; right: 12px;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        z-index: 70;
        background: rgba(20, 18, 15, 0.96);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        backdrop-filter: blur(14px) saturate(140%);
        border: 1px solid rgba(212, 175, 55, 0.35);
        border-radius: 14px;
        padding: 14px 16px;
        color: #F4EEDE;
        font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; line-height: 1.45;
        box-shadow: 0 18px 44px rgba(0,0,0,0.55);
        display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start;
        transform: translateY(140%);
        transition: transform 280ms cubic-bezier(.22,1,.36,1);
      }
      body.has-m-tabs #rp-ios-hint {
        bottom: calc(72px + env(safe-area-inset-bottom, 0px));
      }
      #rp-ios-hint.is-visible { transform: translateY(0); }
      #rp-ios-hint .h {
        font-family: "Cormorant Garamond", serif;
        font-size: 17px; font-weight: 500; color: #D4AF37;
        margin: 0 0 4px;
      }
      #rp-ios-hint .h em { font-style: italic; }
      #rp-ios-hint p { margin: 0; color: #DCD3BF; }
      #rp-ios-hint .ic {
        display: inline-block; vertical-align: -3px; margin: 0 2px;
      }
      #rp-ios-hint .close {
        background: transparent; border: 0; color: #B8AF9D;
        cursor: pointer; padding: 4px 8px; font-size: 18px; line-height: 1;
        align-self: start;
      }
      #rp-ios-hint .close:hover { color: #F4EEDE; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'rp-ios-hint';
    wrap.setAttribute('role', 'status');
    wrap.innerHTML = `
      <div>
        <div class="h">Pasang aplikasi <em>Religio Pro</em></div>
        <p>
          Tap
          <svg class="ic" width="14" height="18" viewBox="0 0 14 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 2v10"/><path d="M3 6l4-4 4 4"/><rect x="1.5" y="7" width="11" height="9" rx="1.5"/>
          </svg>
          di bilah bawah Safari, lalu pilih <strong>Add to Home Screen</strong>.
        </p>
      </div>
      <button type="button" class="close" aria-label="Tutup">×</button>
    `;

    function dismiss() {
      wrap.classList.remove('is-visible');
      try { localStorage.setItem('rp_ios_install_hint_dismissed', '1'); } catch { /* ignore */ }
      trackInstallEvent('IOS_HINT_DISMISSED'); // S360
      setTimeout(() => wrap.remove(), 320);
    }
    wrap.querySelector('.close').addEventListener('click', dismiss);

    document.body.appendChild(wrap);
    // Animate in after the next frame so the transition fires
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('is-visible')));
    trackInstallEvent('IOS_HINT_SHOWN'); // S360 — funnel denominator for iOS path
  }

  function maybeShowIosHint() {
    if (!shouldShowIosHint()) return;
    // Tiny delay so the hint doesn't compete with the first paint.
    setTimeout(injectIosHint, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeShowIosHint, { once: true });
  } else {
    maybeShowIosHint();
  }
})();
