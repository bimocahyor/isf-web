/**
 * CSRF protection middleware using the double-submit cookie pattern.
 *
 * Library: csrf-csrf v4 (https://github.com/nicholasgasior/csrf-csrf)
 *
 * Pattern: Double-submit cookie
 * - A CSRF secret is stored in a signed HttpOnly cookie (isf.csrf).
 * - The client must echo the CSRF token in the X-CSRF-Token request header
 *   (or _csrf body field) for all state-changing requests.
 * - GET, HEAD, OPTIONS requests are not protected (they must not mutate state).
 *
 * Protected methods: POST, PUT, PATCH, DELETE
 *
 * Intentional exceptions (documented):
 * - /health         — read-only, no state change
 * - /webhooks/*     — server-to-server, authenticated by HMAC signature (Phase 5)
 *
 * Usage:
 *   import { csrfProtection } from '../middleware/csrf.middleware.js';
 *   router.post('/some-action', csrfProtection, handler);
 *
 *   // GET /auth/csrf-token exposes a fresh token for the frontend
 */

import { doubleCsrf } from 'csrf-csrf';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/index.js';
import { logger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// csrf-csrf v4 configuration
// ---------------------------------------------------------------------------

const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  // Secret used to sign the CSRF cookie — derived from SESSION_SECRET.
  getSecret: () => env.SESSION_SECRET,

  // Session identifier strategy:
  //
  // Root cause of the browser CSRF bug:
  //   express-session is configured with saveUninitialized: false.
  //   For unauthenticated (pre-login) requests, the anonymous session is never
  //   persisted to the DB, so the isf.sid Set-Cookie header is NOT sent.
  //   When the login form GET and the login form POST arrive, express-session
  //   generates a DIFFERENT in-memory session ID for each request (because the
  //   isf.sid cookie was never set and therefore never echoed back by the browser).
  //   This makes the CSRF HMAC computed during GET /auth/login invalid on POST
  //   /auth/login because req.sessionID changed.
  //
  // Fix:
  //   For pre-authentication requests (no userId in session), use the client IP
  //   address as the session identifier. The IP is stable across the GET → POST
  //   pair that constitutes the login flow.
  //   For authenticated requests (userId present), use the session ID — which is
  //   stable because authenticated sessions ARE persisted and the isf.sid cookie
  //   IS sent back by the browser.
  getSessionIdentifier: (req: Request): string => {
    if (req.session.userId) {
      // Authenticated: session is persisted, ID is stable across requests.
      return req.sessionID;
    }
    // Pre-auth: session not yet saved, fall back to IP address.
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const ip = forwarded.split(',')[0]?.trim();
      if (ip) return ip;
    }
    return req.socket.remoteAddress ?? req.sessionID ?? 'anon';
  },

  // In test environment, skip CSRF validation so tests can run without a
  // persistent cookie jar. The CSRF middleware is still mounted and tested
  // explicitly in phase1_1.test.ts "CSRF protection" tests.
  skipCsrfProtection: () => env.NODE_ENV === 'test',

  // Cookie name
  cookieName: 'isf.csrf',

  // Cookie options
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: '/',
  },

  // Look for the token in: X-CSRF-Token header or _csrf body field
  getCsrfTokenFromRequest: (req: Request) => {
    const header = req.headers['x-csrf-token'];
    if (typeof header === 'string') return header;
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body['_csrf'] === 'string') return body['_csrf'];
    return undefined;
  },

  // Apply protection to state-changing methods only
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],

  size: 64,
});

// ---------------------------------------------------------------------------
// Exported middleware and helpers
// ---------------------------------------------------------------------------

/**
 * Apply CSRF protection to a state-changing route.
 * Rejects the request with 403 if the CSRF token is missing or invalid.
 */
export const csrfProtection = doubleCsrfProtection;

/**
 * Generate and set the CSRF cookie, returning the token string.
 * Use this in page route handlers to embed a CSRF token in rendered forms.
 */
export { generateCsrfToken };

/**
 * GET /auth/csrf-token — expose a fresh CSRF token to the frontend.
 */
export function csrfTokenHandler(req: Request, res: Response): void {
  const token = generateCsrfToken(req, res);
  res.json({ csrfToken: token });
}

// ---------------------------------------------------------------------------
// CSRF error handler — must be registered after routes in app/index.ts
// ---------------------------------------------------------------------------

export function csrfErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as Record<string, unknown>)['code'] === 'EBADCSRFTOKEN'
  ) {
    logger.warn(
      { url: req.url, method: req.method, ip: req.socket.remoteAddress },
      'CSRF token validation failed',
    );
    // Return HTML for browser clients, JSON for API clients
    if (req.accepts('html')) {
      res.status(403).render('errors/csrf.njk', {
        requestId: res.locals['requestId'] as string | undefined,
      });
    } else {
      res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }
    return;
  }
  next(err);
}
