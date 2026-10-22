/**
 * Database migration runner.
 *
 * Run: npm run db:migrate
 *
 * Uses Drizzle's migrate() function which applies pending migrations
 * from the migrations directory in order.
 */

// Load .env before any module that depends on process.env
import 'dotenv/config';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDatabase } from './client.js';
import { logger } from '../shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations(): Promise<void> {
  logger.info('Running database migrations...');
  const db = getDb();
  await migrate(db, {
    migrationsFolder: path.join(__dirname, 'migrations'),
  });
  logger.info('Database migrations completed successfully.');
}

runMigrations()
  .catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  })
  .finally(() => closeDatabase());
