// 5kk: Sender registration shared between in-process server boot and the
// CLI cron job. Idempotent — repeated calls just re-register; safe to call
// from both entry points.
//
// Activation is per-channel, gated on env: present FONNTE_TOKEN wires WA;
// present SMTP_HOST wires EMAIL. Missing env = stay on the console default
// (which is the right behaviour locally and during smoke).
import { env } from '../env.js';
import { setSender } from '../services/notifications.js';
import { makeFonnteSender } from './senders/fonnte.js';
import { makeSmtpSender } from './senders/smtp.js';

let registered = { wa: false, email: false };

export function bootstrapNotifSenders() {
  if (env.FONNTE_TOKEN && !registered.wa) {
    setSender('WA', makeFonnteSender({ token: env.FONNTE_TOKEN, baseUrl: env.FONNTE_BASE_URL }));
    registered.wa = true;
    console.log('[notif] WA sender = Fonnte');
  }
  if (env.SMTP_HOST && env.SMTP_FROM && !registered.email) {
    setSender('EMAIL', makeSmtpSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
      secure: env.SMTP_SECURE,
    }));
    registered.email = true;
    console.log(`[notif] EMAIL sender = SMTP ${env.SMTP_HOST}:${env.SMTP_PORT}`);
  }
  // Silence is golden — no log when nothing wired (default console is fine for dev).
  return { ...registered };
}

// Test-only reset hook so the smoke test can re-bootstrap with mutated env.
export function _resetForTests() {
  registered = { wa: false, email: false };
}
