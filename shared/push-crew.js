// Stage 336 — crew push toggle on /crew. Mirrors push-jemaah.js (S94)
// but uses /crew/push/* endpoints. Same DOM contract:
// #rp-push-bar host with #rp-push-status / #rp-push-enable / #rp-push-disable
// children.
//
// MUTHAWWIF role isn't in admin tier so pushToAdmins() doesn't reach them;
// pushToUser(userId) does (S93 helper). Crew subscribes here to receive
// push for: assigned paket announcements (via push to user channel),
// own incident state changes (future), and ad-hoc broadcasts.

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
      status.textContent = 'Aktifkan notifikasi instant untuk announce paket + ack admin';
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
      const cfg = await fetch('/crew/push/config').then((r) => r.json());
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
      const r = await fetch('/crew/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!r.ok) throw new Error('subscribe failed: ' + r.status);
      await paintStatus();
    } catch (err) {
      console.warn('[push-crew] enable failed:', err);
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
        await fetch('/crew/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      await paintStatus();
    } catch (err) {
      console.warn('[push-crew] disable failed:', err);
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
