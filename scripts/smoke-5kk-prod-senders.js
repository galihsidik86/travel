// Smoke test for 5kk — production notif sender wiring.
//
// Doesn't make real network calls. Verifies:
//   1. normaliseIdPhone covers ID phone variants (08…, +6281…, 6281…, junk).
//   2. makeFonnteSender / makeSmtpSender refuse to construct without required args.
//   3. Fonnte sender skips on missing phone and posts to the configured URL
//      with the right body when phone is present (uses a stubbed fetch).
//   4. bootstrapNotifSenders is idempotent and registers per-channel based on env.
import { normaliseIdPhone, makeFonnteSender } from '../src/lib/senders/fonnte.js';
import { makeSmtpSender } from '../src/lib/senders/smtp.js';
import { bootstrapNotifSenders, _resetForTests } from '../src/lib/notifBootstrap.js';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function main() {
  console.log('\n[5kk smoke]');

  // 1. Phone normalisation
  assert(normaliseIdPhone('081234567890') === '6281234567890', '08… → 628…');
  assert(normaliseIdPhone('+62 812-3456-7890') === '6281234567890', '+6281… with spacing → 6281…');
  assert(normaliseIdPhone('6281234567890') === '6281234567890', '628… pass-through');
  assert(normaliseIdPhone('') === null, 'empty → null');
  assert(normaliseIdPhone(null) === null, 'null → null');
  assert(normaliseIdPhone('not a phone') === null, 'no digits → null');

  // 2. Factory arg guards
  let threw = false;
  try { makeFonnteSender({}); } catch { threw = true; }
  assert(threw, 'makeFonnteSender requires token');
  threw = false;
  try { makeSmtpSender({ host: 'h' }); } catch { threw = true; }
  assert(threw, 'makeSmtpSender requires from');
  threw = false;
  try { makeSmtpSender({ from: 'f' }); } catch { threw = true; }
  assert(threw, 'makeSmtpSender requires host');

  // 3. Fonnte sender behaviour (stub global fetch)
  const send = makeFonnteSender({ token: 'fake-token', baseUrl: 'https://fake.example' });

  const skip = await send({ recipientPhone: '', body: 'x' });
  assert(skip.skip === true && /phone/.test(skip.reason), 'skip when no phone');

  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ status: true }), { status: 200 });
  };
  const ok = await send({ recipientPhone: '0812-3456-7890', subject: 'Hi', body: 'Hello' });
  assert(ok.ok === true, 'fonnte success path returns ok');
  assert(captured.url === 'https://fake.example/send', 'fonnte URL correct');
  assert(captured.init.headers.Authorization === 'fake-token', 'auth header sent');
  const formBody = new URLSearchParams(captured.init.body);
  assert(formBody.get('target') === '6281234567890', 'target normalised in body');
  assert(/Hi/.test(formBody.get('message')) && /Hello/.test(formBody.get('message')), 'subject + body merged');

  // Failure path: Fonnte returns 200 but status=false
  globalThis.fetch = async () => new Response(JSON.stringify({ status: false, reason: 'quota exceeded' }), { status: 200 });
  const fail = await send({ recipientPhone: '0812', body: 'x' });
  assert(fail.ok === false && /quota exceeded/.test(fail.error), 'logical failure surfaces reason');

  // Network error path
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const net = await send({ recipientPhone: '0812', body: 'x' });
  assert(net.ok === false && /ECONNREFUSED/.test(net.error), 'network error surfaces');

  // 4. Bootstrap idempotency (env is the real env — likely no creds set)
  _resetForTests();
  const r1 = bootstrapNotifSenders();
  const r2 = bootstrapNotifSenders();
  assert(typeof r1.wa === 'boolean' && typeof r1.email === 'boolean', 'bootstrap returns shape');
  assert(r1.wa === r2.wa && r1.email === r2.email, 'bootstrap idempotent across calls');
  console.log(`  bootstrap state (from .env): wa=${r1.wa} email=${r1.email}`);

  console.log('\n[5kk smoke] PASS\n');
}

main().catch((err) => { console.error('[5kk smoke] ERROR:', err); process.exitCode = 1; });
