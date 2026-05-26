import { ZodError } from 'zod';
import { isProd } from '../env.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFoundHandler(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { message: 'Endpoint not found', code: 'NOT_FOUND' } });
  }
  res.status(404).type('text/plain').send('Not found');
}

export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Internal server error';
  let details;

  if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Permintaan tidak valid';
    details = err.flatten().fieldErrors;
  }

  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    console.error(err.stack || err);
    if (isProd) message = 'Terjadi kesalahan internal';
  }

  const isApi = req.path.startsWith('/api/');
  if (isApi) {
    return res.status(status).json({
      error: { message, code, ...(details && { details }) },
    });
  }

  // HTML flows: redirect to login on 401, render error.ejs otherwise.
  if (status === 401 && req.method === 'GET') {
    const next = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${next}`);
  }
  return res.status(status).render('error', { code: status, message });
}
