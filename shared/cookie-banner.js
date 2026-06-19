// Stage 383 — UU PDP cookie consent banner.
//
// Renders a bottom-fixed banner on public pages disclosing what cookies
// we set + linking to the privacy page. Dismissable via localStorage
// flag `rp_cookie_consent_v1`. Banner shows once per browser per major
// version (`_v1` in the key — bump when consent text changes materially).
//
// What we actually set:
//   - rp_csrf (CSRF double-submit token, session)
//   - rp_session (login session JWT, when logged in)
//   - rp_vis (visitor analytics id, 1 year — used by S48 paket view tracking)
//
// We don't load 3rd-party analytics or ads — so this is a minimal disclosure,
// not a complex consent management platform. If we later add Meta Pixel or
// Google Analytics, this banner should grow a "Tolak" button that gates
// those scripts.

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const KEY = 'rp_cookie_consent_v1';

  function alreadyDismissed() {
    try { return localStorage.getItem(KEY) === '1'; } catch (_e) { return false; }
  }
  function dismiss() {
    try { localStorage.setItem(KEY, '1'); } catch (_e) { /* private mode */ }
  }
  function inject() {
    if (document.getElementById('rp-cookie-banner')) return;
    const style = document.createElement('style');
    style.textContent = `
      #rp-cookie-banner {
        position: fixed; left: 12px; right: 12px;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        z-index: 80;
        background: rgba(20, 18, 15, 0.97);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        backdrop-filter: blur(14px) saturate(140%);
        border: 1px solid rgba(212, 175, 55, 0.4);
        border-radius: 12px;
        padding: 14px 16px;
        color: #F4EEDE;
        font-family: var(--font-mono, "JetBrains Mono"), monospace;
        font-size: 12px; line-height: 1.5;
        box-shadow: 0 14px 36px rgba(0,0,0,0.55);
        display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
        max-width: 720px; margin: 0 auto;
        transform: translateY(140%);
        transition: transform 280ms cubic-bezier(.22,1,.36,1);
      }
      #rp-cookie-banner.is-visible { transform: translateY(0); }
      #rp-cookie-banner .lbl { color: var(--gold-300, #D4AF6B); font-weight: 600; }
      #rp-cookie-banner .link { color: var(--gold-300, #D4AF6B); text-decoration: underline; }
      #rp-cookie-banner button {
        background: var(--gold-300, #D4AF6B); color: #0A0908; border: 0;
        padding: 8px 18px; border-radius: 6px; cursor: pointer;
        font-family: inherit; font-size: 11px; letter-spacing: 0.12em;
        text-transform: uppercase; font-weight: 700;
      }
      @media (max-width: 480px) {
        #rp-cookie-banner { grid-template-columns: 1fr; gap: 8px; }
        #rp-cookie-banner button { width: 100%; }
      }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'rp-cookie-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Cookie consent');
    wrap.innerHTML = `
      <div>
        <span class="lbl">🍪 Penggunaan cookie.</span>
        Kami menyimpan cookie untuk: keamanan login (CSRF + sesi),
        dan ID kunjungan anonim untuk statistik halaman.
        Tidak ada cookie pihak ketiga (analytics/ads).
        <a class="link" href="/saya/privasi">Pelajari lebih lanjut →</a>
      </div>
      <button type="button" id="rp-cookie-ok">OK, Saya Mengerti</button>
    `;
    wrap.querySelector('#rp-cookie-ok').addEventListener('click', () => {
      dismiss();
      wrap.classList.remove('is-visible');
      setTimeout(() => wrap.remove(), 320);
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('is-visible')));
  }

  function maybeShow() {
    if (alreadyDismissed()) return;
    // Small delay so the banner doesn't compete with the first paint
    setTimeout(inject, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeShow, { once: true });
  } else {
    maybeShow();
  }
})();
