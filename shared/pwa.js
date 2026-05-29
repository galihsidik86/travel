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

  // Capture the install prompt so we can fire it from a user gesture later.
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.body.dataset.pwaInstallable = '1';
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
    btn.dispatchEvent(new CustomEvent('pwa:choice', { bubbles: true, detail: choice }));
  });

  // Auto-hide install affordances after the app is already installed.
  window.addEventListener('appinstalled', () => {
    delete document.body.dataset.pwaInstallable;
  });
})();
