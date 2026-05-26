import { Router } from 'express';
import { env } from '../env.js';
import { pingDb } from '../lib/db.js';

const router = Router();

router.get('/', async (req, res) => {
  const dbCheck = env.DATABASE_URL ? await pingDb() : { ok: null, skipped: true };

  res.json({
    status: dbCheck.ok === false ? 'degraded' : 'ok',
    service: 'religio-pro',
    version: '0.1.0',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    checks: {
      db: dbCheck,
    },
  });
});

export default router;
