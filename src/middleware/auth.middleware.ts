/**
 * RBAC middleware factory.
 *
 * Provides two middleware factories:
 *
 *   requireAuth()                    — ensures the request has an active session
 *   requirePermission(permission)    — ensures the session user holds the permission
 *
 * Authorization denial (403) is written to the audit log as a critical event.
 *
 * IMPORTANT: These middlewares only check role-based permissions.
 * Resource-level ownership checks (IDOR prevention) must be done in
 * the service layer, not here.
 *
 * UUID primary keys are NOT a substitute for ownership checks.
 * Every resource access must verify BOTH:
 *   1. The user holds the required permission (checked here)
 *   2. The user is authorized to access that specific resource instance
 *      (checked in the service layer, via ownership/assignment queries)
 */

import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../shared/errors.js';
import { hasPermission, isRole } from '../shared/rbac.js';
import type { Permission } from '../shared/rbac.js';
import { recordAuditEventCritical, AuditAction } from '../shared/audit.js';

// ---------------------------------------------------------------------------
// requireAuth — session existence check
// ---------------------------------------------------------------------------

/**
 * Middleware that rejects requests without an active authenticated session.
 * Responds with 401 Unauthorized.
 */
export function requireAuth() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session.userId) {
      return next(new UnauthorizedError('Authentication required'));
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// requirePermission — role/permission check
// ---------------------------------------------------------------------------

/**
 * Middleware that rejects requests where the session user does not hold
 * the specified permission.
 *
 * Implies requireAuth: if there is no session, returns 401 before
 * checking the permission.
 *
 * On permission failure: records an audit event and returns 403 Forbidden.
 */
export function requirePermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // Must be authenticated first
    if (!req.session.userId) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const role = req.session.userRole;

    // Defensive: if the role stored in session is somehow invalid, reject
    if (!role || !isRole(role)) {
      return next(new ForbiddenError('Invalid session role'));
    }

    if (!hasPermission(role, permission)) {
      // Audit the denial — awaited (critical security event)
      await recordAuditEventCritical({
        actorId: req.session.userId,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.AUTHORIZATION_DENIED,
        metadata: {
          permission,
          role,
          url: req.url,
          method: req.method,
        },
        ipAddress:
          typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0]?.trim() ?? null
            : (req.socket.remoteAddress ?? null),
      });

      return next(new ForbiddenError('Insufficient permissions'));
    }

    next();
  };
}
