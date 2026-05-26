// 5pp: Midtrans Snap HTTP client + webhook signature verifier.
//
// Two modes:
//   • Real:  MIDTRANS_SERVER_KEY present → POST to api.sandbox.midtrans.com or
//            app.midtrans.com (per MIDTRANS_PRODUCTION). Auth = HTTP Basic with
//            base64(server_key + ':').
//   • Fake:  no server key → returns a synthetic snap_token + a local fake URL.
//            Lets dev + smoke exercise intent → webhook without external creds.
//
// Webhook signature (Midtrans Notification API):
//   signature_key = SHA512(order_id + status_code + gross_amount + server_key)
import crypto from 'node:crypto';
import { env } from '../env.js';

const SNAP_TIMEOUT_MS = 15_000;

function snapBaseUrl() {
  return env.MIDTRANS_PRODUCTION
    ? 'https://app.midtrans.com/snap/v1'
    : 'https://app.sandbox.midtrans.com/snap/v1';
}

export function isMidtransFakeMode() {
  return !env.MIDTRANS_SERVER_KEY;
}

/**
 * Create a Snap transaction. Returns { token, redirect_url }.
 * In fake mode, returns deterministic synthetic values that include the
 * orderId so the local fake-payment handler can resolve back to the intent.
 */
export async function createSnapTransaction({ orderId, amount, customer, itemName }) {
  if (isMidtransFakeMode()) {
    return {
      token: `fake-snap-${orderId}`,
      redirect_url: `/payments/midtrans/fake?order_id=${encodeURIComponent(orderId)}`,
      fake: true,
    };
  }
  const auth = Buffer.from(`${env.MIDTRANS_SERVER_KEY}:`).toString('base64');
  const body = {
    transaction_details: { order_id: orderId, gross_amount: Math.round(amount) },
    item_details: [{
      id: 'BOOKING', price: Math.round(amount), quantity: 1,
      name: (itemName || 'Booking Religio Pro').slice(0, 50),
    }],
    customer_details: customer ? {
      first_name: customer.fullName?.slice(0, 50),
      email: customer.email || undefined,
      phone: customer.phone || undefined,
    } : undefined,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SNAP_TIMEOUT_MS);
  try {
    const res = await fetch(`${snapBaseUrl()}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || !parsed.token) {
      const msg = parsed.error_messages?.join('; ') || parsed.message || `HTTP ${res.status}`;
      throw new Error(`Midtrans Snap: ${msg}`);
    }
    return { token: parsed.token, redirect_url: parsed.redirect_url, fake: false };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verify the Midtrans webhook signature_key.
 * SHA512(order_id + status_code + gross_amount + server_key)
 * Returns true/false. In fake mode (no server key) we still verify against
 * empty key — so smoke can produce valid fake signatures deterministically.
 */
export function verifyMidtransSignature(payload) {
  const { order_id, status_code, gross_amount, signature_key } = payload || {};
  if (!order_id || !status_code || !gross_amount || !signature_key) return false;
  const serverKey = env.MIDTRANS_SERVER_KEY || '';
  const expected = crypto.createHash('sha512')
    .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
    .digest('hex');
  // Constant-time comparison — both sides are hex strings of equal length
  if (expected.length !== signature_key.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature_key));
}

/**
 * Map a Midtrans `transaction_status` (and optional `fraud_status`) to one
 * of our PaymentIntentStatus values. Reference:
 * https://docs.midtrans.com/reference/transaction-status
 */
export function mapMidtransStatus({ transaction_status, fraud_status }) {
  switch (transaction_status) {
    case 'capture':
      // For credit card, `accept` = success, `challenge`/`deny` = review/denied
      if (fraud_status === 'accept') return 'SETTLED';
      if (fraud_status === 'deny') return 'FAILED';
      return 'PENDING';
    case 'settlement':
      return 'SETTLED';
    case 'pending':
      return 'PENDING';
    case 'deny':
    case 'failure':
      return 'FAILED';
    case 'cancel':
      return 'CANCELLED';
    case 'expire':
      return 'EXPIRED';
    case 'refund':
    case 'partial_refund':
      // Refunds come through a separate admin flow; webhook just notes the
      // gateway side. We don't auto-translate to anything actionable here.
      return 'SETTLED';
    default:
      return 'PENDING';
  }
}

/**
 * Translate a Midtrans payment_type to our PaymentMethod enum.
 * Defaults to TRANSFER for anything unrecognised so audit captures the raw
 * type in `notes` and the booking still gets credited.
 */
export function mapMidtransMethod(payment_type) {
  switch (payment_type) {
    case 'credit_card':       return 'CARD';
    case 'bank_transfer':
    case 'echannel':          return 'VA';
    case 'qris':              return 'QRIS';
    case 'gopay':
    case 'shopeepay':
    case 'dana':
    case 'linkaja':           return 'EWALLET';
    case 'cstore':            return 'TRANSFER';
    default:                  return 'TRANSFER';
  }
}
