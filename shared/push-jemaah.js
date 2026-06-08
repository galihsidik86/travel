// Stage 94 — jemaah push toggle on /saya. Mirrors push-admin.js but uses
// the /api/saya/push/* endpoints (S93). Renders into a #rp-push-bar host
// element with #rp-push-status / #rp-push-enable / #rp-push-disable
// children — same DOM contract so admin + jemaah pages can share CSS.

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
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const b = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function paintStatus() {
    if (!supported) {
      status.textContent = 'Notifikasi push: browser ini tidak support';
      btnEnable.style.display = 'none';
      btnDisable.style.display = 'none';
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Notifikasi push: izin ditolak (atur ulang di browser)';
      btnEnable.style.display = 'none';
      btnDisable.style.display = 'none';
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration('/shared/sw.js')
      || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      status.textContent = '✓ Notifikasi aktif di perangkat ini';
      status.style.color = 'var(--emerald)';
      btnEnable.style.display = 'none';
      btnDisable.style.display = 'inline-block';
    } else {
      status.textContent = 'Aktifkan notifikasi instant untuk booking + pembayaran';
      status.style.color = 'var(--ink-200)';
      btnEnable.style.display = 'inline-block';
      btnDisable.style.display = 'none';
    }
  }

  async function enable() {
    btnEnable.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        status.textContent = 'Notifikasi: izin tidak diberikan';
        btnEnable.disabled = false;
        return;
      }
      const cfg = await fetch('/api/saya/push/config').then((r) => r.json());
      if (!cfg.publicKey) {
        status.textContent = 'Server belum siap menerima push (admin perlu set VAPID key)';
        btnEnable.disabled = false;
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration('/shared/sw.js')
        || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
      });
      const r = await fetch('/api/saya/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!r.ok) throw new Error('subscribe failed: ' + r.status);
      await paintStatus();
    } catch (err) {
      console.warn('[push-jemaah] enable failed:', err);
      status.textContent = 'Gagal aktif — coba lagi';
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
        await fetch('/api/saya/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      await paintStatus();
    } catch (err) {
      console.warn('[push-jemaah] disable failed:', err);
    } finally {
      btnDisable.disabled = false;
    }
  }

  btnEnable.addEventListener('click', enable);
  btnDisable.addEventListener('click', disable);

  if (supported) {
    if (navigator.serviceWorker.controller) paintStatus();
    else setTimeout(paintStatus, 1000);
  } else {
    paintStatus();
  }
})();
