import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('localhost'),

  // Step 2 — required once Prisma is wired in
  DATABASE_URL: z.string().url().optional(),

  // Step 3 — required once JWT auth is wired in
  JWT_SECRET: z.string().min(32).optional(),
  JWT_TTL: z.string().default('7d'),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Production rate limit backend. When set, rateLimit() uses Redis (multi-
  // instance safe). When absent, falls back to in-memory bucket (single-
  // instance only). Format: redis://[user:pass@]host:port[/db] or rediss://
  REDIS_URL: z.string().min(1).optional(),

  // 5pp — Midtrans payment gateway. All optional. When MIDTRANS_SERVER_KEY
  // is absent the gateway service runs in *fake mode*: it still produces
  // intents (with a synthetic snap token + a local /payments/midtrans/fake
  // redirect URL) so dev + smoke can exercise the full path without creds.
  PUBLIC_BASE_URL: z.string().url().optional(),
  // S354 — Religio Pro admin contact surfaced in the jemaah quick-
  // contact panel. WA number stored in `62…` format (no leading 0,
  // no spaces — matches the Fonnte adapter convention). Both
  // optional; missing values hide the corresponding button.
  PUBLIC_ADMIN_WA: z.string().regex(/^\d{8,15}$/).optional(),
  PUBLIC_ADMIN_PHONE: z.string().min(8).optional(),
  MIDTRANS_SERVER_KEY: z.string().min(1).optional(),
  MIDTRANS_CLIENT_KEY: z.string().min(1).optional(),
  MIDTRANS_PRODUCTION: z.coerce.boolean().default(false),

  // 5kk — Production notif adapters. All optional; missing values keep the
  // console-default sender. Activation is per-channel: present FONNTE_TOKEN
  // wires WA; present SMTP_HOST wires EMAIL.
  FONNTE_TOKEN: z.string().min(1).optional(),
  FONNTE_BASE_URL: z.string().url().default('https://api.fonnte.com'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(), // e.g. "Religio Pro <noreply@religio.pro>"
  SMTP_SECURE: z.coerce.boolean().default(false), // true for port 465

  // Jemaah SOS-light (S321) cooldown — minutes between consecutive SOS
  // submissions per booking. Lowered default from 30 to 5 because real
  // emergencies need follow-up info (kondisi memburuk, lokasi pindah);
  // 30min blocked legitimate updates. 0 = no cooldown (admin-side dedup
  // via push tag handles spam). Clamp [0..120].
  SOS_COOLDOWN_MIN: z.coerce.number().int().min(0).max(120).default(5),

  // Stage 17 — Web Push. Generate VAPID keypair via the npm script
  //   npx web-push generate-vapid-keys
  // and drop the result into .env. When VAPID_PUBLIC is absent the push
  // service falls back to console fake-mode (no real send, but the
  // subscribe/unsubscribe DB ops still work).
  VAPID_PUBLIC: z.string().min(1).optional(),
  VAPID_PRIVATE: z.string().min(1).optional(),
  VAPID_CONTACT: z.string().default('mailto:admin@religio.pro'),
});

const parsed = Schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.flatten().fieldErrors;
  console.error('Invalid environment configuration:');
  for (const [field, msgs] of Object.entries(issues)) {
    console.error(`  ${field}: ${msgs?.join(', ')}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

// Production-mode hard requirements. The base schema keeps these optional so
// dev/test can boot with a half-filled .env, but a live deploy that skips any
// of these would be unsafe — fail fast at boot.
if (isProd) {
  const prodIssues = [];
  if (!env.DATABASE_URL) prodIssues.push('DATABASE_URL is required');
  if (!env.JWT_SECRET) prodIssues.push('JWT_SECRET is required (min 32 chars)');
  if (env.COOKIE_DOMAIN === 'localhost') {
    prodIssues.push('COOKIE_DOMAIN=localhost is unsafe in production — set to your public domain');
  }
  if (!env.COOKIE_SECURE) {
    prodIssues.push('COOKIE_SECURE must be true behind HTTPS');
  }
  if (env.MIDTRANS_PRODUCTION && (!env.MIDTRANS_SERVER_KEY || !env.MIDTRANS_CLIENT_KEY)) {
    prodIssues.push('MIDTRANS_PRODUCTION=true requires both MIDTRANS_SERVER_KEY and MIDTRANS_CLIENT_KEY');
  }
  if (prodIssues.length > 0) {
    console.error('Invalid production environment configuration:');
    for (const msg of prodIssues) console.error(`  - ${msg}`);
    process.exit(1);
  }
}
