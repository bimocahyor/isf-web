/**
 * Drizzle ORM database client.
 *
 * Creates a single PostgreSQL connection pool shared across the application.
 * The pool is initialized lazily on first use and can be closed on shutdown.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/index.js';
import { logger } from '../shared/logger.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err: Error) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

export function getDb(): ReturnType<typeof drizzle> {
  if (!db) {
    db = drizzle(getPool());
  }
  return db;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Verify that the database is reachable.
 * Returns true on success, false on failure.
 * Does NOT throw — suitable for use in health checks.
 */
export async function checkDatabaseHealth(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    logger.info('Database connection pool closed');
  }
}
