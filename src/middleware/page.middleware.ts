/**
 * Page middleware — authentication and authorization guards for browser pages.
 *
 * requirePageAuth()            — redirect unauthenticated users to /auth/login
 * requirePageRole(role)        — deny access if user's role is insufficient
 * requirePagePermission(perm)  — deny access by permission
 *
 * These guards produce HTML responses (302 redirect or 403 page) when the
 * requesting client accepts text/html, unlike the API guards which return JSON.
 *
 * Authorization is always enforced server-side — hiding UI elements is only
 * a UX improvement, not a security control.
 */

import type { Request, Response, NextFunction } from 'express';
import { hasPermission, isRole } from '../shared/rbac.js';
import type { Permission, Role } from '../shared/rbac.js';
import { recordAuditEventCritical, AuditAction } from '../shared/audit.js';

// ---------------------------------------------------------------------------
// requirePageAuth — redirect to login if not authenticated
// ---------------------------------------------------------------------------

/**
 * Redirect unauthenticated browser requests to /auth/login.
 * Returns 401 JSON for non-browser clients.
 */
export function requirePageAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.session.userId) {
      next();
      return;
    }

    if (req.accepts('html')) {
      // Preserve the intended destination for post-login redirect (optional UX)
      res.redirect(302, '/auth/login');
    } else {
      res.status(401).json({ error: 'Authentication required' });
    }
  };
}

// ---------------------------------------------------------------------------
// requirePageRole — 403 for wrong role
// ---------------------------------------------------------------------------

/**
 * Allow access only if the session user's role matches one of the allowed roles.
 * Implies requirePageAuth.
 */
export function requirePageRole(...allowedRoles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session.userId) {
      if (req.accepts('html')) {
        res.redirect(302, '/auth/login');
      } else {
        res.status(401).json({ error: 'Authentication required' });
      }
      return;
    }

    const role = req.session.userRole;
    if (!role || !isRole(role) || !allowedRoles.includes(role)) {
      await recordAuditEventCritical({
        actorId: req.session.userId,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.AUTHORIZATION_DENIED,
        metadata: {
          requiredRoles: [...allowedRoles],
          actualRole: role ?? null,
          url: req.url,
          method: req.method,
        },
        ipAddress:
          typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0]?.trim() ?? null
            : (req.socket.remoteAddress ?? null),
      });

      if (req.accepts('html')) {
        const requestId = res.locals['requestId'] as string | undefined;
        res.status(403).render('errors/403.njk', {
          requestId,
        });
      } else {
        res.status(403).json({ error: 'Insufficient permissions' });
      }
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// requirePagePermission — 403 for missing permission
// ---------------------------------------------------------------------------

/**
 * Allow access only if the session user holds the given permission.
 * Implies requirePageAuth.
 */
export function requirePagePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session.userId) {
      if (req.accepts('html')) {
        res.redirect(302, '/auth/login');
      } else {
        res.status(401).json({ error: 'Authentication required' });
      }
      return;
    }

    const role = req.session.userRole;
    if (!role || !isRole(role) || !hasPermission(role, permission)) {
      await recordAuditEventCritical({
        actorId: req.session.userId,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.AUTHORIZATION_DENIED,
        metadata: {
          permission,
          role: role ?? null,
          url: req.url,
          method: req.method,
        },
        ipAddress:
          typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0]?.trim() ?? null
            : (req.socket.remoteAddress ?? null),
      });

      if (req.accepts('html')) {
        const requestId = res.locals['requestId'] as string | undefined;
        res.status(403).render('errors/403.njk', {
          requestId,
        });
      } else {
        res.status(403).json({ error: 'Insufficient permissions' });
      }
      return;
    }

    next();
  };
}
