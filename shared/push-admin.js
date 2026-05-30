// Admin push toggle bar — registers the browser for Web Push and POSTs the
// subscription to /api/admin/push/subscribe. Renders inside #rp-push-bar
// on pages that include this script (currently /admin/incidents).

(function () {
  if (typeof window === 'undefined') return;
  const bar = document.getElementById('rp-push-bar');
  const status = document.getElementById('rp-push-status');
  const btnEnable = document.getElementById('rp-push-enable');
  const btnDisable = document.getElementById('rp-push-disable');
  if (!bar || !status || !btnEnable || !btnDisable) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  bar.style.display = 'inline-flex';

  function urlBase64ToUint8Array(b64) {
    // VAPID public key is URL-safe base64; convert to Uint8Array for the
    // PushManager.subscribe() applicationServerKey arg.
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const b = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function paintStatus() {
    if (!supported) {
      status.textContent = 'Push: browser tidak support';
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Push: izin ditolak (cek pengaturan browser)';
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration('/shared/sw.js')
      || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      status.textContent = 'Push: aktif di perangkat ini';
      status.style.color = 'var(--emerald)';
      btnEnable.style.display = 'none';
      btnDisable.style.display = 'inline-block';
    } else {
      status.textContent = 'Push: belum aktif';
      status.style.color = 'var(--ink-200)';
      btnEnable.style.display = 'inline-block';
      btnDisable.style.display = 'none';
    }
  }

  async function enable() {
    btnEnable.disabled = true;
    try {
      // 1. Permission
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        status.textContent = 'Push: izin tidak diberikan';
        btnEnable.disabled = false;
        return;
      }
      // 2. Public key
      const cfg = await fetch('/api/admin/push/config').then((r) => r.json());
      if (!cfg.publicKey) {
        status.textContent = 'Push: server belum punya VAPID key (set VAPID_PUBLIC + VAPID_PRIVATE)';
        btnEnable.disabled = false;
        return;
      }
      // 3. Subscribe
      const reg = await navigator.serviceWorker.getRegistration('/shared/sw.js')
        || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
      });
      // 4. Persist server-side. csrf.js auto-attaches the header.
      const r = await fetch('/api/admin/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!r.ok) throw new Error('subscribe failed: ' + r.status);
      await paintStatus();
    } catch (err) {
      console.warn('[push] enable failed:', err);
      status.textContent = 'Push: gagal aktif — coba lagi';
    } finally {
      btnEnable.disabled = false;
    }
  }

  async function disable() {
    btnDisable.disabled = true;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/shared/sw.js')
        || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/admin/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      await paintStatus();
    } catch (err) {
      console.warn('[push] disable failed:', err);
    } finally {
      btnDisable.disabled = false;
    }
  }

  btnEnable.addEventListener('click', enable);
  btnDisable.addEventListener('click', disable);

  // First paint after the SW had a chance to register (pwa.js runs on load).
  if (supported) {
    if (navigator.serviceWorker.controller) paintStatus();
    else setTimeout(paintStatus, 1000);
  } else {
    paintStatus();
  }
})();
