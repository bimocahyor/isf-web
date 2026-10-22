/**
 * Auth pages router — server-rendered browser UI for authentication flows.
 *
 * This router handles GET (render form) and browser-oriented POST (redirect
 * on success/failure) routes for:
 *   GET  /auth/login
 *   GET  /auth/register
 *   GET  /auth/forgot-password
 *   GET  /auth/reset-password
 *   GET  /auth/verify-email    (handles token verification with HTML response)
 *   POST /auth/login           (browser form → redirect on success)
 *   POST /auth/register        (browser form → redirect to success page)
 *   POST /auth/forgot-password (browser form → show sent message)
 *   POST /auth/reset-password  (browser form → redirect to login on success)
 *   POST /auth/logout          (browser form → redirect to login)
 *
 * Security notes:
 * - CSRF token is embedded in every rendered form.
 * - POST handlers detect browser vs API requests via Accept header and
 *   form vs JSON Content-Type.
 * - The existing API-style auth.router.ts handlers remain unchanged and
 *   continue to function for API consumers.
 * - Role-aware redirects after login use the session role set by the
 *   existing auth.service login() function.
 */

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError, z } from 'zod';
import {
  register,
  login,
  verifyEmailToken,
  createPasswordResetToken,
  consumePasswordResetToken,
} from './auth.service.js';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.schemas.js';
import {
  getInvitationByToken,
  acceptInvitation,
} from '../invitations/invitation.service.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { recordAuditEventCritical, AuditAction } from '../../shared/audit.js';
import type { Role } from '../../shared/rbac.js';
import { BadRequestError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Rate limiters (relaxed in test)
// ---------------------------------------------------------------------------

const isTest = process.env['NODE_ENV'] === 'test';

const loginPageLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: isTest ? 1_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts, please try again later.',
  skipSuccessfulRequests: false,
});

const registerPageLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: isTest ? 1_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many registration attempts, please try again later.',
  skipSuccessfulRequests: false,
});

const forgotPageLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: isTest ? 1_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.',
  skipSuccessfulRequests: false,
});

const resetPageLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: isTest ? 1_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.',
  skipSuccessfulRequests: false,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Browser detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the request looks like a browser HTML form submission.
 *
 * Criteria (any of):
 *   - Content-Type is application/x-www-form-urlencoded or multipart/form-data
 *   - Accept header prefers text/html
 *   - _csrf field is present in the body (browser form pattern)
 *
 * When false, pass through to the API router (JSON consumer).
 */
function isBrowserRequest(req: Request): boolean {
  // Form-encoded body → browser form
  if (req.is('application/x-www-form-urlencoded') || req.is('multipart/form-data')) {
    return true;
  }
  // JSON body → API client
  if (req.is('application/json')) {
    return false;
  }
  // Accept header prefers HTML
  const accept = req.headers['accept'] ?? '';
  if (accept.includes('text/html')) {
    return true;
  }
  // If X-CSRF-Token header is set, it's an API client using the header pattern
  if (req.headers['x-csrf-token']) {
    return false;
  }
  // Default: treat as API client to preserve backward compatibility
  return false;
}

function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? null;
  return req.socket.remoteAddress ?? null;
}

function currentYear(): number {
  return new Date().getFullYear();
}

/** Returns the CSRF token, setting the CSRF cookie as a side effect. */
function csrf(req: Request, res: Response): string {
  return generateCsrfToken(req, res);
}

/** Role → default landing URL after login */
function roleRedirectUrl(role: Role): string {
  switch (role) {
    case 'OWNER':
      return '/owner';
    case 'ADMIN':
      return '/admin';
    case 'EDITOR':
      return '/admin/editor';
    case 'REVIEWER':
      return '/admin/reviewer';
    default:
      return '/portal';
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const authPagesRouter = Router();

// ---------------------------------------------------------------------------
// GET /auth/login
// ---------------------------------------------------------------------------

authPagesRouter.get('/login', (req, res) => {
  // Already logged in → redirect to portal
  if (req.session.userId) {
    const url = roleRedirectUrl((req.session.userRole as Role) ?? 'USER');
    res.redirect(302, url);
    return;
  }

  const info = req.query['info'] === 'password-reset'
    ? 'Your password has been reset. Please sign in with your new password.'
    : req.query['info'] === 'verified'
    ? 'Your email has been verified. Please sign in.'
    : undefined;

  res.render('auth/login.njk', {
    csrfToken: csrf(req, res),
    year: currentYear(),
    info,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login  (browser form submission)
//
// If the request has Content-Type: application/json or Accept: application/json
// pass through to the API router (authRouter) which handles JSON consumers.
// ---------------------------------------------------------------------------

authPagesRouter.post('/login', loginPageLimiter, async (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  const body = req.body as Record<string, unknown> | undefined;
  const bodyEmail: string | null =
    typeof body?.['email'] === 'string' ? body['email'] : null;

  try {
    const input = loginSchema.parse(req.body);
    const { user } = await login(input);

    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) =>
        err ? reject(new Error(String(err))) : resolve(),
      ),
    );

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userRole = user.role as Role;
    req.session.createdAt = Date.now();

    await recordAuditEventCritical({
      actorId: user.id,
      actorEmail: user.email,
      action: AuditAction.LOGIN_SUCCESS,
      entityType: 'user',
      entityId: user.id,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.redirect(302, roleRedirectUrl(user.role as Role));
  } catch (err) {
    // Record failed login attempt
    await recordAuditEventCritical({
      actorId: null,
      actorEmail: bodyEmail,
      action: AuditAction.LOGIN_FAILED,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    let errorMsg = 'Invalid email or password.';
    const fieldErrors: Record<string, string> = {};

    if (err instanceof ZodError) {
      for (const e of err.errors) {
        const field = e.path.join('.');
        if (field) fieldErrors[field] = e.message;
      }
      errorMsg = 'Please correct the errors below.';
    }
    // Do not distinguish between "invalid credentials" and "account inactive"
    // to prevent email enumeration.

    res.status(401).render('auth/login.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      error: errorMsg,
      fieldErrors,
      formValues: { email: bodyEmail ?? '' },
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/register
// ---------------------------------------------------------------------------

authPagesRouter.get('/register', (req, res) => {
  if (req.session.userId) {
    res.redirect(302, '/portal');
    return;
  }
  res.render('auth/register.njk', {
    csrfToken: csrf(req, res),
    year: currentYear(),
  });
});

// ---------------------------------------------------------------------------
// POST /auth/register  (browser form submission)
// ---------------------------------------------------------------------------

authPagesRouter.post('/register', registerPageLimiter, async (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  try {
    const parsed = registerSchema.parse(req.body);
    const input = {
      email: parsed.email,
      password: parsed.password,
      ...(parsed.displayName !== undefined && { displayName: parsed.displayName }),
    };
    const { user } = await register(input);

    // Start a fresh session for the newly registered user
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) =>
        err ? reject(new Error(String(err))) : resolve(),
      ),
    );
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userRole = user.role as Role;
    req.session.createdAt = Date.now();

    await recordAuditEventCritical({
      actorId: user.id,
      actorEmail: user.email,
      action: AuditAction.USER_REGISTERED,
      entityType: 'user',
      entityId: user.id,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.render('auth/register-success.njk', { year: currentYear() });
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const e of err.errors) {
        const field = e.path.join('.');
        if (field) fieldErrors[field] = e.message;
      }
      const formBodyZod = req.body as Record<string, unknown> | undefined;
      res.status(422).render('auth/register.njk', {
        csrfToken: csrf(req, res),
        year: currentYear(),
        fieldErrors,
        formValues: {
          email: typeof formBodyZod?.['email'] === 'string' ? formBodyZod['email'] : '',
          displayName: typeof formBodyZod?.['displayName'] === 'string' ? formBodyZod['displayName'] : '',
        },
        error: 'Please correct the errors below.',
      });
      return;
    }

    // Duplicate email — show generic error (do not confirm email existence)
    const isDuplicate =
      err instanceof Error && err.constructor.name === 'ConflictError';

    const formBodyReg = req.body as Record<string, unknown> | undefined;
    res.status(isDuplicate ? 409 : 500).render('auth/register.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      error: isDuplicate
        ? 'An account with that email already exists.'
        : 'Registration failed. Please try again.',
      formValues: {
        email: typeof formBodyReg?.['email'] === 'string' ? formBodyReg['email'] : '',
        displayName: typeof formBodyReg?.['displayName'] === 'string' ? formBodyReg['displayName'] : '',
      },
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/forgot-password
// ---------------------------------------------------------------------------

authPagesRouter.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password.njk', {
    csrfToken: csrf(req, res),
    year: currentYear(),
  });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password  (browser form)
// ---------------------------------------------------------------------------

authPagesRouter.post('/forgot-password', forgotPageLimiter, async (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  // Always show the same success message regardless of outcome (anti-enumeration)
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (parsed.success) {
      await createPasswordResetToken(parsed.data.email, getClientIp(req));
    }
    // Silently ignore validation failures — same response (anti-enumeration)
  } catch (err) {
    // Log real server errors but do not surface them
    logger.error({ err }, 'Error in forgot-password page handler');
  }

  res.render('auth/forgot-password.njk', {
    csrfToken: csrf(req, res),
    year: currentYear(),
    sent: true,
  });
});

// ---------------------------------------------------------------------------
// GET /auth/reset-password?token=...
// ---------------------------------------------------------------------------

authPagesRouter.get('/reset-password', (req, res) => {
  const token = typeof req.query['token'] === 'string' ? req.query['token'] : null;

  if (!token) {
    res.render('auth/reset-password.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      tokenError: 'No reset token was provided. Please use the link from your email.',
    });
    return;
  }

  res.render('auth/reset-password.njk', {
    csrfToken: csrf(req, res),
    year: currentYear(),
    token,
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password  (browser form)
// ---------------------------------------------------------------------------

authPagesRouter.post('/reset-password', resetPageLimiter, async (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  const resetBody = req.body as Record<string, unknown> | undefined;
  const token = typeof resetBody?.['token'] === 'string' ? resetBody['token'] : '';
  const newPassword = typeof resetBody?.['newPassword'] === 'string' ? resetBody['newPassword'] : '';

  try {
    const parsed = resetPasswordSchema.parse({ token, newPassword });
    const { userId } = await consumePasswordResetToken(parsed.token, parsed.newPassword);

    // Invalidate current session if it belongs to the reset user
    if (req.session.userId === userId) {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      res.clearCookie('isf.sid');
    }

    await recordAuditEventCritical({
      actorId: userId,
      actorEmail: null,
      action: AuditAction.PASSWORD_RESET_COMPLETED,
      entityType: 'user',
      entityId: userId,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    // Redirect to login with success indicator
    res.redirect(302, '/auth/login?info=password-reset');
  } catch (err) {
    let tokenError: string | undefined;
    let error: string | undefined;
    const fieldErrors: Record<string, string> = {};

    if (err instanceof ZodError) {
      for (const e of err.errors) {
        const field = e.path.join('.');
        if (field) fieldErrors[field] = e.message;
      }
      error = 'Please correct the errors below.';
    } else if (err instanceof BadRequestError) {
      const msg = err.message;
      if (msg.includes('expired')) {
        tokenError = 'This reset link has expired. Please request a new one.';
      } else if (msg.includes('already been used')) {
        tokenError = 'This reset link has already been used. Please request a new one.';
      } else {
        tokenError = 'This reset link is invalid. Please request a new one.';
      }
    } else {
      next(err);
      return;
    }

    res.status(400).render('auth/reset-password.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      token: tokenError ? undefined : token,
      tokenError,
      error,
      fieldErrors,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/verify-email?token=...  (browser-visible verification experience)
// ---------------------------------------------------------------------------

authPagesRouter.get('/verify-email', async (req, res, next) => {
  // Non-browser clients (API) get the JSON response from the API router
  if (!isBrowserRequest(req) && !(req.headers['accept'] ?? '').includes('text/html')) {
    next();
    return;
  }

  const rawToken =
    typeof req.query['token'] === 'string' ? req.query['token'] : null;

  if (!rawToken) {
    res.render('auth/verify-email.njk', {
      year: currentYear(),
      status: 'missing',
    });
    return;
  }

  try {
    const result = await verifyEmailToken(rawToken);

    await recordAuditEventCritical({
      actorId: result.userId,
      actorEmail: null,
      action: AuditAction.EMAIL_VERIFIED,
      entityType: 'user',
      entityId: result.userId,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.render('auth/verify-email.njk', {
      year: currentYear(),
      status: 'success',
    });
  } catch (err) {
    if (err instanceof BadRequestError) {
      // Token invalid, expired, or already used — do not log raw token
      const msg = err.message;
      let status = 'invalid';
      if (msg.includes('expired')) status = 'expired';
      res.render('auth/verify-email.njk', {
        year: currentYear(),
        status,
      });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout  (browser form)
// ---------------------------------------------------------------------------

authPagesRouter.post('/logout', requireAuth(), (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  const actorId = req.session.userId ?? null;
  const actorEmail = req.session.userEmail ?? null;
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] ?? null;

  req.session.destroy((err) => {
    if (err) {
      next(err);
      return;
    }

    recordAuditEventCritical({
      actorId,
      actorEmail,
      action: AuditAction.LOGOUT,
      ipAddress: ip,
      userAgent: ua,
    }).then(() => {
      res.clearCookie('isf.sid');
      res.redirect(302, '/auth/login');
    }).catch(next);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/accept-invitation — show form to set password and accept invite
// ---------------------------------------------------------------------------

const acceptInvitationSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  confirmPassword: z.string(),
  displayName: z.string().min(1, 'Display name is required').max(100).optional(),
  token: z.string().min(1),
}).refine((d) => d.password === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

authPagesRouter.get('/accept-invitation', async (req, res, next) => {
  try {
    const rawToken = typeof req.query['token'] === 'string' ? req.query['token'] : '';
    if (!rawToken) {
      return res.render('auth/accept-invitation.njk', {
        csrfToken: csrf(req, res),
        year: currentYear(),
        state: 'invalid',
        message: 'Invalid or missing invitation link.',
        token: '',
        email: null,
        role: null,
      });
    }

    const inv = await getInvitationByToken(rawToken).catch(() => null);
    if (!inv) {
      return res.render('auth/accept-invitation.njk', {
        csrfToken: csrf(req, res),
        year: currentYear(),
        state: 'invalid',
        message: 'This invitation link is invalid, expired, or has already been used.',
        token: '',
        email: null,
        role: null,
      });
    }

    return res.render('auth/accept-invitation.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      state: 'valid',
      message: null,
      token: rawToken,
      email: inv.email,
      role: inv.role,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/accept-invitation — create account from invitation
// ---------------------------------------------------------------------------

authPagesRouter.post('/accept-invitation', async (req, res, next) => {
  if (!isBrowserRequest(req)) { next(); return; }

  const body = req.body as Record<string, unknown>;
  const rawToken = typeof body['token'] === 'string' ? body['token'] : '';
  const bodyEmail = typeof body['email'] === 'string' ? body['email'] : null;
  const bodyRole = typeof body['role'] === 'string' ? body['role'] : null;
  const bodyDisplayName = typeof body['displayName'] === 'string' ? body['displayName'] : '';

  const renderError = (message: string) =>
    res.status(400).render('auth/accept-invitation.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      state: 'valid',
      message,
      token: rawToken,
      email: bodyEmail,
      role: bodyRole,
      displayName: bodyDisplayName,
      isError: true,
    });

  try {
    const parsed = acceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message ?? 'Invalid input';
      return renderError(msg);
    }

    const result = await acceptInvitation({
      rawToken,
      password: parsed.data.password,
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
    });

    await recordAuditEventCritical({
      actorId: result.userId,
      actorEmail: result.email,
      action: AuditAction.USER_REGISTERED,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      metadata: { method: 'invitation', role: result.role },
    });

    logger.info({ userId: result.userId, role: result.role }, 'Invitation accepted — account created');

    return res.render('auth/accept-invitation.njk', {
      csrfToken: csrf(req, res),
      year: currentYear(),
      state: 'accepted',
      message: null,
      token: '',
      email: result.email,
      role: result.role,
    });
  } catch (err) {
    if (err instanceof BadRequestError || err instanceof ZodError) {
      return renderError(
        err instanceof ZodError
          ? (err.errors[0]?.message ?? 'Invalid input')
          : err.message,
      );
    }
    next(err);
  }
});
