/**
 * Auth router
 *
 * Routes:
 *   POST /auth/register            — create account, send verification email
 *   POST /auth/login               — authenticate and create session
 *   POST /auth/logout              — destroy session
 *   GET  /auth/me                  — session check
 *   GET  /auth/verify-email        — verify email address via token
 *   POST /auth/forgot-password     — request password reset (generic response)
 *   POST /auth/reset-password      — consume reset token, set new password
 *
 * Security decisions:
 * - Session is REGENERATED after login to prevent session fixation.
 * - Session is DESTROYED on logout (not just cleared).
 * - forgot-password always returns the same generic 200 response (no enumeration).
 * - Password reset invalidates all active sessions for the user.
 * - Security-critical audit events are awaited (not fire-and-forget).
 * - Rate limiters are applied per endpoint. Relaxed in test environment.
 */

import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import type { Role } from '../../shared/rbac.js';
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
import { recordAuditEventCritical, AuditAction } from '../../shared/audit.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const isTest = process.env['NODE_ENV'] === 'test';

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,   // 1 hour
  max: isTest ? 1_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, please try again later.' },
  skipSuccessfulRequests: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,   // 15 minutes
  max: isTest ? 1_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: false,
});

// Forgot-password: same generic limit regardless of outcome (prevents enumeration
// via differential rate-limit behaviour).
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,   // 1 hour
  max: isTest ? 1_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skipSuccessfulRequests: false,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,   // 1 hour
  max: isTest ? 1_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skipSuccessfulRequests: false,
});

// ---------------------------------------------------------------------------
// Helper: extract client IP
// ---------------------------------------------------------------------------

function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? null;
  return req.socket.remoteAddress ?? null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const authRouter = Router();

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

authRouter.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const parsed = registerSchema.parse(req.body);
    const input = {
      email: parsed.email,
      password: parsed.password,
      ...(parsed.displayName !== undefined && { displayName: parsed.displayName }),
    };
    const { user } = await register(input);

    // Start a fresh session
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

    res.status(201).json({
      message: 'Account created. Please check your email to verify your address.',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        emailVerified: false,
      },
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(422).json({
        error: 'Validation failed',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const { user } = await login(input);

    // Regenerate session to prevent session fixation
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

    res.json({
      message: 'Logged in successfully',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(422).json({
        error: 'Validation failed',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }

    const bodyEmail: string | null =
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as Record<string, unknown>)['email'] === 'string'
        ? ((req.body as Record<string, unknown>)['email'] as string)
        : null;

    // Await critical audit even on failure path
    await recordAuditEventCritical({
      actorId: null,
      actorEmail: bodyEmail,
      action: AuditAction.LOGIN_FAILED,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });

    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

authRouter.post('/logout', requireAuth(), (req, res, next) => {
  const actorId = req.session.userId ?? null;
  const actorEmail = req.session.userEmail ?? null;
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] ?? null;

  req.session.destroy((err) => {
    if (err) {
      next(err);
      return;
    }

    // Audit after session is destroyed — fire critical audit then send response
    recordAuditEventCritical({
      actorId,
      actorEmail,
      action: AuditAction.LOGOUT,
      ipAddress: ip,
      userAgent: ua,
    }).then(() => {
      res.clearCookie('isf.sid');
      res.json({ message: 'Logged out successfully' });
    }).catch(next);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

authRouter.get('/me', requireAuth(), (req, res) => {
  res.json({
    id: req.session.userId,
    email: req.session.userEmail,
    role: req.session.userRole,
  });
});

// ---------------------------------------------------------------------------
// GET /auth/verify-email?token=<raw_token>
// ---------------------------------------------------------------------------

authRouter.get('/verify-email', async (req, res, next) => {
  try {
    const rawToken =
      typeof req.query['token'] === 'string' ? req.query['token'] : null;

    if (!rawToken) {
      res.status(400).json({ error: 'Verification token is required' });
      return;
    }

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

    res.json({ message: 'Email address verified successfully.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------

authRouter.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  // Generic response regardless of outcome — prevents email enumeration.
  const GENERIC_RESPONSE = {
    message: 'If an account with that email exists, a password reset link has been sent.',
  };

  try {
    const parsed = forgotPasswordSchema.parse(req.body);

    // createPasswordResetToken handles the case where the email does not exist
    // (returns silently). Errors thrown are only real server errors.
    await createPasswordResetToken(parsed.email, getClientIp(req));

    res.json(GENERIC_RESPONSE);
  } catch (err) {
    if (err instanceof ZodError) {
      // Even validation errors return the generic response — do not reveal
      // whether the email is valid/registered.
      res.json(GENERIC_RESPONSE);
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

authRouter.post('/reset-password', resetPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.parse(req.body);
    const { userId } = await consumePasswordResetToken(
      parsed.token,
      parsed.newPassword,
    );

    // Invalidate the current session if the user is logged in
    // (they may have reset from a session on a compromised device)
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

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(422).json({
        error: 'Validation failed',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});
