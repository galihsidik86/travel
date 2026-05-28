import { Router } from 'express';
import { env } from '../env.js';
import { pingDb } from '../lib/db.js';
import { getJobFreshness } from '../lib/jobRunner.js';

const router = Router();

router.get('/', async (_req, res) => {
  const dbCheck = env.DATABASE_URL ? await pingDb() : { ok: null, skipped: true };

  // Job freshness — best-effort. Failing this check shouldn't break /health
  // (which uptime probes hit). Catch + degrade rather than 500.
  let jobs;
  try {
    jobs = dbCheck.ok ? await getJobFreshness() : null;
  } catch (err) {
    jobs = { error: err.message };
  }

  // Aggregate status: "degraded" if DB down OR any job is stale (last
  // successful run > 2× expected cadence). External uptime monitors can
  // alert on this single field; the breakdown is available for triage.
  const anyJobStale = Array.isArray(jobs) && jobs.some((j) => !j.ok);
  const status = dbCheck.ok === false ? 'degraded'
               : anyJobStale            ? 'degraded'
               :                          'ok';

  res.json({
    status,
    service: 'religio-pro',
    version: '0.1.0',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    checks: {
      db: dbCheck,
      jobs,
    },
  });
});

export default router;
