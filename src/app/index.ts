/**
 * Express application factory.
 *
 * Separating the app factory from the server entry point allows
 * tests to import the app without starting a real TCP server.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import nunjucks from 'nunjucks';
import { v4 as uuidv4 } from 'uuid';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';

import { env } from '../config/index.js';
import { logger } from '../shared/logger.js';
import { AppError, NotFoundError } from '../shared/errors.js';
import { getPool } from '../db/client.js';
import { healthRouter } from '../modules/health/health.router.js';
import { authRouter } from '../modules/auth/auth.router.js';
import { authPagesRouter } from '../modules/auth/auth.pages.router.js';
import { usersRouter } from '../modules/users/users.router.js';
import { portalRouter } from '../modules/portal/portal.router.js';
import { adminRouter } from '../modules/admin/admin.router.js';
import { ownerRouter } from '../modules/owner/owner.router.js';
import {
  csrfProtection,
  csrfTokenHandler,
  csrfErrorHandler,
} from '../middleware/csrf.middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(): Express {
  const app = express();

  // -------------------------------------------------------------------------
  // Trust proxy — required when behind Nginx or a load balancer
  // -------------------------------------------------------------------------
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // -------------------------------------------------------------------------
  // Request ID — attach a unique ID to every request for traceability
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const id = uuidv4();
    res.setHeader('X-Request-Id', id);
    res.locals['requestId'] = id;
    next();
  });

  // -------------------------------------------------------------------------
  // HTTP security headers (Helmet)
  // -------------------------------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: [
            "'self'",
            'https://fonts.googleapis.com',
          ],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: [
            "'self'",
            'data:',
            'https://images.unsplash.com',
          ],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
      // HSTS — only active in production (served over HTTPS)
      strictTransportSecurity: env.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
      crossOriginEmbedderPolicy: false, // Allow Unsplash images in landing page
    }),
  );

  // -------------------------------------------------------------------------
  // Request logging (Pino HTTP)
  // -------------------------------------------------------------------------
  app.use(
    pinoHttp({
      logger,
      // Do not log health check requests to reduce noise
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      customLogLevel: (
        _req: Request,
        res: Response,
        err: Error | undefined,
      ) => {
        if (err != null || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customProps: (_req: Request, res: Response) => ({
        requestId: res.locals['requestId'] as string | undefined,
      }),
    }),
  );

  // -------------------------------------------------------------------------
  // Cookie parser — required by csrf-csrf to read the CSRF cookie
  // Must come before session and CSRF middleware.
  // -------------------------------------------------------------------------
  app.use(cookieParser());

  // -------------------------------------------------------------------------
  // Body parsing
  // -------------------------------------------------------------------------
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // -------------------------------------------------------------------------
  // Global rate limiting — foundation only, tightened per-route in later phases
  // -------------------------------------------------------------------------
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1_000, // 15 minutes
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: (req) => req.url === '/health',
  });
  app.use(globalLimiter);

  // -------------------------------------------------------------------------
  // Session middleware (connect-pg-simple PostgreSQL session store)
  //
  // Security: cookies are HttpOnly, SameSite=Strict.
  // In production, Secure=true (requires HTTPS).
  // -------------------------------------------------------------------------
  const PgSession = ConnectPgSimple(session);

  app.use(
    session({
      store: new PgSession({
        pool: getPool(),
        tableName: 'sessions',
        // Purge expired sessions every 1 hour
        pruneSessionInterval: 60 * 60,
        // Error handler — log but don't crash
        errorLog: (err: Error) =>
          logger.error({ err }, 'connect-pg-simple session store error'),
      }),
      secret: env.SESSION_SECRET,
      name: 'isf.sid',
      resave: false,
      saveUninitialized: false,
      rolling: true, // Slide the expiry window on activity
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1_000, // 30 days
      },
    }),
  );

  // -------------------------------------------------------------------------
  // Nunjucks template engine
  // -------------------------------------------------------------------------
  const viewsDir = path.join(__dirname, '..', 'views');
  nunjucks.configure(viewsDir, {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true,
    express: app,
    noCache: env.NODE_ENV !== 'production',
  });
  app.set('view engine', 'njk');
  app.set('views', viewsDir);

  // -------------------------------------------------------------------------
  // Static files — serve the ISF landing page and assets
  //
  // Security: express.static is configured to only serve files from public/.
  // The backend source (src/), migrations, .env, etc. are entirely outside
  // this directory and cannot be served regardless of path traversal attempts.
  // -------------------------------------------------------------------------
  const publicDir = path.resolve(__dirname, '..', '..', 'public');
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      // Do not expose directory listings
      redirect: false,
      // Cache static assets in production
      maxAge: env.NODE_ENV === 'production' ? '7d' : '0',
      // Explicitly disallow dotfile access (defense in depth)
      dotfiles: 'deny',
    }),
  );

  // -------------------------------------------------------------------------
  // Application routes
  // -------------------------------------------------------------------------
  app.use('/health', healthRouter);

  // CSRF token endpoint — GET, so no CSRF protection needed on this route itself
  app.get('/auth/csrf-token', csrfTokenHandler);

  // Auth pages router — browser GET/POST for login, register, etc.
  // CSRF protection is applied; GET routes are exempt by middleware config.
  app.use('/auth', csrfProtection, authPagesRouter);

  // Auth API router — JSON API for programmatic access
  app.use('/auth', csrfProtection, authRouter);

  app.use('/api/v1/users', csrfProtection, usersRouter);

  // Portal, admin, and owner page routers
  app.use('/portal', csrfProtection, portalRouter);
  app.use('/admin', csrfProtection, adminRouter);
  app.use('/owner', csrfProtection, ownerRouter);

  // Module routers registered here as they are implemented in later phases:
  // app.use('/api/v1',     csrfProtection, apiRouter);
  // app.use('/webhooks',   webhookRouter);  // webhooks use HMAC, not CSRF

  // -------------------------------------------------------------------------
  // CSRF error handler — must be before the general 404/error handlers
  // -------------------------------------------------------------------------
  app.use(csrfErrorHandler);

  // -------------------------------------------------------------------------
  // 404 handler — must come after all routes
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    const requestId = res.locals['requestId'] as string | undefined;
    if (_req.accepts('html')) {
      res.status(404).render('errors/404.njk', { requestId });
    } else {
      res.status(404).json({ error: 'Not found', requestId });
    }
  });

  // -------------------------------------------------------------------------
  // Central error handler
  // -------------------------------------------------------------------------
  app.use(
    (
      err: unknown,
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const requestId = res.locals['requestId'] as string | undefined;

      if (err instanceof AppError && err.isOperational) {
        // Known, safe-to-surface operational error
        logger.warn({ err, requestId, url: req.url }, err.message);

        if (req.accepts('html')) {
          if (err instanceof NotFoundError) {
            res.status(err.statusCode).render('errors/404.njk', { requestId });
          } else {
            res.status(err.statusCode).render('errors/500.njk', { requestId });
          }
        } else {
          res.status(err.statusCode).json({
            error: err.message,
            requestId,
          });
        }
      } else {
        // Unknown / programming error — log fully, never expose internals
        logger.error(
          { err, requestId, url: req.url },
          'Unhandled error',
        );

        if (req.accepts('html')) {
          res.status(500).render('errors/500.njk', { requestId });
        } else {
          res.status(500).json({
            error: 'Internal server error',
            requestId,
          });
        }
      }
    },
  );

  return app;
}
