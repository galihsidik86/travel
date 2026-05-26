// Fonnte WhatsApp sender (5kk). Fonnte's API is a simple form-encoded POST
// to /send with `target` + `message`; the `Authorization` header carries the
// device token. Built-in fetch is enough — no SDK.
//
// Adapter contract (matches notifications.js SENDERS):
//   input:  notif row (uses .recipientPhone + .body + optional .subject)
//   output: { ok: true } | { ok: false, error } | { skip: true, reason }
//
// Phone normalisation: Fonnte accepts E.164 without '+', and our DB phones
// vary (`+6281…`, `0812…`). We normalise: strip everything non-digit, drop
// a leading 0 in favour of '62' (Indonesia country code). Numbers already
// starting with 62 pass through.
//
// Docs: https://docs.fonnte.com/
const FONNTE_TIMEOUT_MS = 15_000;

export function normaliseIdPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits; // assume already international (rare for ID)
}

export function makeFonnteSender({ token, baseUrl = 'https://api.fonnte.com' }) {
  if (!token) throw new Error('makeFonnteSender: token required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/send`;

  return async function fonnteSend(notif) {
    const target = normaliseIdPhone(notif.recipientPhone);
    if (!target) return { skip: true, reason: 'no recipient phone' };

    // Fonnte combines subject + body into one message; we include subject as
    // a bold-ish header line when present, else just the body.
    const message = notif.subject
      ? `*${notif.subject}*\n\n${notif.body}`
      : notif.body;

    const form = new URLSearchParams({ target, message });

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FONNTE_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }

      // Fonnte returns 200 even on logical failure; success requires `status: true`.
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      if (body.status === true || body.status === 'true') return { ok: true };
      const reason = body.reason || body.message || JSON.stringify(body).slice(0, 200);
      return { ok: false, error: `Fonnte: ${reason}` };
    } catch (err) {
      const msg = err.name === 'AbortError' ? `timeout after ${FONNTE_TIMEOUT_MS}ms` : err.message;
      return { ok: false, error: `Fonnte network: ${msg}` };
    } finally {
      clearTimeout(timeout);
    }
  };
}
