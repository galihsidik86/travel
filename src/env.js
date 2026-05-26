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

  // 5pp — Midtrans payment gateway. All optional. When MIDTRANS_SERVER_KEY
  // is absent the gateway service runs in *fake mode*: it still produces
  // intents (with a synthetic snap token + a local /payments/midtrans/fake
  // redirect URL) so dev + smoke can exercise the full path without creds.
  PUBLIC_BASE_URL: z.string().url().optional(),
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
