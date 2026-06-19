// Stage 352 — in-app push toast. Listens for SW postMessage events
// (the SW push handler emits `{kind:'rp-push', title, body, url, tag}`)
// and renders a top banner so users notice push events while the PWA
// is actively in the foreground (system notifications often get missed
// when the user is already inside the app).
//
// The system notification still fires from the SW (browser-policy
// requirement) so this is purely additive. Auto-dismiss after 8s;
// tap to navigate; close button to dismiss.

(function () {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  // Styles + host element injected once on first toast.
  let host = null;
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = 'rp-toast-host';
    host.style.cssText = [
      'position: fixed',
      'top: env(safe-area-inset-top, 0)',
      'left: 0', 'right: 0', 'z-index: 9999',
      'display: flex', 'flex-direction: column', 'gap: 8px',
      'padding: 12px',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(host);
    return host;
  }

  function renderToast({ title, body, url, tag, ts }) {
    const h = ensureHost();
    // Dedupe same-tag toast (mirrors SW notification.tag behavior)
    if (tag) {
      const prior = h.querySelector(`[data-rp-toast-tag="${CSS.escape(tag)}"]`);
      if (prior) prior.remove();
    }
    const card = document.createElement('div');
    card.setAttribute('data-rp-toast-tag', tag || '');
    card.style.cssText = [
      'pointer-events: auto',
      'background: rgba(10, 9, 8, 0.96)',
      '-webkit-backdrop-filter: blur(12px) saturate(140%)',
      'backdrop-filter: blur(12px) saturate(140%)',
      'border: 1px solid var(--gold-300, #d4af6b)',
      'border-radius: 8px',
      'padding: 12px 14px',
      'box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4)',
      'color: var(--cream-100, #e8e3d4)',
      'font-family: var(--font-mono, monospace)',
      'font-size: 12.5px',
      'line-height: 1.5',
      'max-width: 480px',
      'margin: 0 auto',
      'cursor: pointer',
      'transition: opacity 200ms ease, transform 200ms ease',
      'transform: translateY(-8px)',
      'opacity: 0',
    ].join(';');

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-family: var(--font-display, serif); font-size: 14px; color: var(--gold-300, #d4af6b); margin-bottom: 4px; font-weight: 500;';
    titleEl.textContent = title || 'Religio Pro';

    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'color: var(--ink-100, #c5beaa); line-height: 1.55;';
    bodyEl.textContent = body || '';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Tutup');
    closeBtn.style.cssText = 'position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: var(--ink-200, #8d8675); font-size: 18px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.textContent = '×';

    card.style.position = 'relative';
    card.appendChild(closeBtn);
    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    h.appendChild(card);

    // Trigger entry animation on next frame
    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });

    function dismiss() {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-8px)';
      setTimeout(() => card.remove(), 220);
    }

    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    card.addEventListener('click', () => {
      if (url) {
        try { window.location.href = url; } catch (_err) { /* swallowed */ }
      }
      dismiss();
    });
    // Auto-dismiss after 8 s (don't auto-dismiss SOS-style tags that
    // typically carry requireInteraction at the OS layer).
    if (!tag || !tag.startsWith('sos')) {
      setTimeout(dismiss, 8000);
    }
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.kind !== 'rp-push') return;
    try {
      renderToast(data);
    } catch (err) {
      console.warn('[in-app-toast] render failed', err);
    }
  });
})();
