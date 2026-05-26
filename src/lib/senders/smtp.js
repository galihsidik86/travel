// SMTP email sender (5kk) backed by nodemailer. Works with Mailgun, SES,
// Postmark, or any plain SMTP relay.
//
// Adapter contract (matches notifications.js SENDERS):
//   input:  notif row (uses .recipientEmail + .subject + .body)
//   output: { ok: true } | { ok: false, error } | { skip: true, reason }
//
// Body is sent as plain text. If notif.payload?.html is set in future, we
// can extend to multipart — kept simple for now since our templates are text.
import nodemailer from 'nodemailer';

export function makeSmtpSender({ host, port = 587, user, pass, from, secure = false }) {
  if (!host) throw new Error('makeSmtpSender: host required');
  if (!from) throw new Error('makeSmtpSender: from required');

  const transporter = nodemailer.createTransport({
    host, port, secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  return async function smtpSend(notif) {
    if (!notif.recipientEmail) return { skip: true, reason: 'no recipient email' };
    try {
      await transporter.sendMail({
        from,
        to: notif.recipientEmail,
        subject: notif.subject || '(no subject)',
        text: notif.body,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `SMTP: ${err.message}` };
    }
  };
}

// Exposed for boot-time validation. Returns a promise that resolves on success
// or rejects with the SMTP error — useful when wiring at startup so we fail
// loudly instead of discovering broken creds on the first real send.
export async function verifySmtp(transporter) {
  return transporter.verify();
}
