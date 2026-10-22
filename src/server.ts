/**
 * Server entry point.
 *
 * Starts the HTTP server and handles graceful shutdown.
 * This module is NOT imported in tests — tests import createApp() directly.
 */

// Load .env before any other import that reads process.env.
// This must be the very first import in the entry point.
import 'dotenv/config';

import { createApp } from './app/index.js';
import { env } from './config/index.js';
import { logger } from './shared/logger.js';
import { closeDatabase } from './db/client.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      url: env.APP_BASE_URL,
    },
    `ISF Platform server started`,
  );
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received — closing server gracefully');

  server.close(() => {
    closeDatabase()
      .then(() => {
        logger.info('Server closed cleanly');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  });

  // Force-kill after 10 seconds if shutdown hangs
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});
