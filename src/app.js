import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';

import { env, isDev } from './env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { csrfProtection } from './middleware/csrf.js';
import { fmt } from './lib/format.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import authWebRouter from './routes/authWeb.js';
import { paketHtmlRouter, paketJsonRouter } from './routes/paket.js';
import paketChildrenRouter from './routes/paketChildren.js';
import bookingRouter from './routes/booking.js';
import agenRouter from './routes/agen.js';
import leadsRouter from './routes/leads.js';
import adminRouter from './routes/admin.js';
import paketAdminRouter from './routes/paketAdmin.js';
import usersAdminRouter from './routes/users.js';
import jemaahAdminRouter from './routes/jemaah.js';
import jemaahDocsRouter from './routes/jemaahDocs.js';
import bookingsAdminRouter from './routes/bookings.js';
import payoutsRouter from './routes/payouts.js';
import jemaahPortalRouter from './routes/jemaahPortal.js';
import crewRouter from './routes/crew.js';
import auditRouter from './routes/audit.js';
import jobsRouter from './routes/jobs.js';
import notificationsRouter from './routes/notifications.js';
import paymentIntentsRouter from './routes/paymentIntents.js';
import incidentsRouter from './routes/incidents.js';
import pushRouter from './routes/push.js';
import paymentsRouter from './routes/payments.js';
import paymentGatewayRouter from './routes/paymentGateway.js';
import refundsRouter from './routes/refunds.js';
import bunkingRouter from './routes/bunking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const SENSITIVE_FILES = new Set([
  '/.env',
  '/.env.example',
  '/package.json',
  '/package-lock.json',
  '/CLAUDE.md',
]);
const SENSITIVE_PREFIXES = ['/node_modules/', '/src/', '/prisma/', '/.git/', '/.claude/', '/memory/', '/private/', '/scripts/'];

function blockSensitive(req, res, next) {
  const p = req.path;
  if (SENSITIVE_FILES.has(p) || SENSITIVE_PREFIXES.some((pre) => p.startsWith(pre))) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
}

function requestLog(req, _res, next) {
  if (isDev && !req.path.startsWith('/shared/') && !req.path.endsWith('.css')) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path}`);
  }
  next();
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  // Make formatters available to every template
  app.use((_req, res, next) => {
    res.locals.fmt = fmt;
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestLog);
  app.use(blockSensitive);
  // CSRF protection (double-submit cookie). After cookieParser + body parsers
  // so it can read the cookie + form body. Skips GET + webhooks + health.
  app.use(csrfProtection({ cookieSecure: env.COOKIE_SECURE }));

  // API
  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  // Nested CRUD (admin only) mounts FIRST so /:slug/hotels and /:slug/days
  // beat the public GET /:slug.
  app.use('/api/paket', paketChildrenRouter);
  app.use('/api/paket', paketJsonRouter);
  app.use('/api/booking', bookingRouter);
  app.use('/api/leads', leadsRouter);
  // 5pp: payment gateway (mounts /api/payments/intent + /api/payments/midtrans/webhook
  // + /payments/midtrans/fake). Defines its full paths so it's mounted at root.
  // MUST come BEFORE paymentsRouter — that router has `router.use(requireAuth, …)`
  // which would intercept any /api/payments/* prefix and 401 the webhook before
  // signature verify ever runs.
  app.use('/', paymentGatewayRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/refunds', refundsRouter);
  app.use('/api/admin/jobs', jobsRouter);
  app.use('/api/admin/push', pushRouter);
  app.use('/api/bunking', bunkingRouter);
  app.use('/api/jemaah', jemaahDocsRouter);

  // Browser auth (HTML form, cookie-based)
  app.use('/', authWebRouter);

  // Dynamic paket landing (/p/:slug)
  app.use('/p', paketHtmlRouter);

  // Jemaah self-service portal: HTML /register (public), /saya (JEMAAH), /api/saya/claim
  app.use('/', jemaahPortalRouter);

  // Agent CRM (/agen) — requires AGEN role
  app.use('/agen', agenRouter);

  // Crew portal (/crew) — requires MUTHAWWIF role (5oo)
  app.use('/crew', crewRouter);

  // Admin/HQ dashboard (/admin) — OWNER/SUPERADMIN/MANAJER_OPS
  // paket admin sub-routes mount first so they take precedence on path overlap
  app.use('/admin/paket', paketAdminRouter);
  app.use('/admin/users', usersAdminRouter);
  app.use('/admin/jemaah', jemaahAdminRouter);
  app.use('/admin/bookings', bookingsAdminRouter);
  app.use('/admin/payouts', payoutsRouter);
  app.use('/admin/audit', auditRouter);
  app.use('/admin/notifications', notificationsRouter);
  app.use('/admin/payment-intents', paymentIntentsRouter);
  app.use('/admin/incidents', incidentsRouter);
  app.use('/admin', adminRouter);

  // Static — existing design package (index.html, screens/, shared/, uploads/)
  app.use(
    express.static(projectRoot, {
      dotfiles: 'deny',
      index: 'index.html',
      extensions: ['html'],
      maxAge: isDev ? 0 : '1d',
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
