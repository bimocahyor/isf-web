/**
 * Health check router.
 *
 * GET /health — application liveness probe
 *
 * Returns:
 *   200 { status: "ok", ... }        — application is live
 *   503 { status: "degraded", ... }  — application is live but a dependency is unavailable
 *
 * Security: never expose secrets, database credentials, or internal paths.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { checkDatabaseHealth } from '../../db/client.js';
import { env } from '../../config/index.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const dbHealth = await checkDatabaseHealth();

  const payload: Record<string, unknown> = {
    status: dbHealth.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    checks: {
      database: dbHealth.ok
        ? { status: 'ok', latencyMs: dbHealth.latencyMs }
        : { status: 'unavailable', error: dbHealth.error },
    },
  };

  const httpStatus = dbHealth.ok ? 200 : 503;
  res.status(httpStatus).json(payload);
});
