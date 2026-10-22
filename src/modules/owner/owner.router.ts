/**
 * Owner router — OWNER-only dashboard and user management.
 *
 * GET /owner                — owner dashboard
 * GET /owner/users          — list users
 * GET /owner/users/:id      — view user detail
 * POST /owner/users/:id/role        — change role
 * POST /owner/users/:id/disable     — disable account
 * POST /owner/users/:id/reactivate  — reactivate account
 * POST /owner/users/:id/revoke-sessions — revoke all sessions
 * GET  /owner/invitations           — list pending invitations
 * POST /owner/invite                — create invitation
 * POST /owner/invitations/:id/revoke — revoke invitation
 *
 * All routes require OWNER role — enforced by requirePageRole('OWNER').
 * User management routes additionally require 'user:manage' permission.
 */

import { type Request, type Response, type NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { requirePageRole, requirePagePermission } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import {
  listUsers,
  getUserDetail,
  changeUserRole,
  disableUser,
  reactivateUser,
  revokeUserSessions,
} from '../users/user-management.service.js';
import {
  createInvitation,
  listPendingInvitations,
  revokeInvitation,
} from '../invitations/invitation.service.js';
import { isRole, ROLES } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { recordAuditEventCritical, AuditAction } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';

export const ownerRouter = Router();

const isTest = process.env['NODE_ENV'] === 'test';

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: isTest ? 1_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many invitation requests, please try again later.',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csrf(req: Parameters<typeof generateCsrfToken>[0], res: Parameters<typeof generateCsrfToken>[1]): string {
  return generateCsrfToken(req, res);
}

function year(): number {
  return new Date().getFullYear();
}

async function baseLocals(req: Request, res: Response): Promise<Record<string, unknown>> {
  const user = req.session.userId ? await getUserById(req.session.userId) : null;
  return {
    csrfToken: csrf(req, res),
    year: year(),
    userEmail: req.session.userEmail,
    userRole: req.session.userRole,
    displayName: user?.displayName || req.session.userEmail,
  };
}

type Req = Request;
type Res = Response;
type Next = NextFunction;

/** Extract a named route param safely as a string (Express params are always strings). */
function paramStr(req: Request, name: string): string {
  const v = req.params[name];
  return typeof v === 'string' ? v : '';
}

/** Extract a query string value safely as a string or undefined. */
function queryStr(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// GET /owner
// ---------------------------------------------------------------------------

ownerRouter.get('/', requirePageRole('OWNER'), async (req: Req, res: Res, next: Next) => {
  try {
    const { total } = await listUsers({ limit: 1 });
    const locals = await baseLocals(req, res);
    res.render('owner/index.njk', { ...locals, userCount: total });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /owner/users
// ---------------------------------------------------------------------------

ownerRouter.get(
  '/users',
  requirePageRole('OWNER'),
  requirePagePermission('user:manage'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const searchRaw = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
      const pageRaw = typeof req.query['page'] === 'string' ? req.query['page'] : '1';
      const page = Math.max(1, parseInt(pageRaw, 10) || 1);
      const limit = 20;
      const offset = (page - 1) * limit;

      const listOpts: Parameters<typeof listUsers>[0] = { limit, offset };
      if (searchRaw !== undefined) listOpts.search = searchRaw;

      const { users, total } = await listUsers(listOpts);
      const search = searchRaw;
      const locals = await baseLocals(req, res);

      res.render('owner/users.njk', {
        ...locals,
        users,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        search: search ?? '',
        roles: ROLES.filter((r) => r !== 'OWNER'),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /owner/users/:id
// ---------------------------------------------------------------------------

ownerRouter.get(
  '/users/:id',
  requirePageRole('OWNER'),
  requirePagePermission('user:view'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const targetUser = await getUserDetail(paramStr(req, 'id'));
      const locals = await baseLocals(req, res);
      const assignableRoles = ROLES.filter((r) => r !== 'OWNER');

      res.render('owner/user-detail.njk', {
        ...locals,
        targetUser,
        assignableRoles,
        error: queryStr(req, 'error'),
        success: queryStr(req, 'success'),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/users/:id/role
// ---------------------------------------------------------------------------

const changeRoleSchema = z.object({
  role: z.string().refine((v) => isRole(v) && v !== 'OWNER', {
    message: 'Invalid or unauthorized role',
  }),
});

ownerRouter.post(
  '/users/:id/role',
  requirePageRole('OWNER'),
  requirePagePermission('user:change_role'),
  async (req: Req, res: Res, next: Next) => {
    const targetId = paramStr(req, 'id');
    try {
      const parsed = changeRoleSchema.parse(req.body);
      // Zod refine validates this is a valid non-OWNER Role
      const newRole = parsed.role as unknown as Role;
      await changeUserRole({
        targetUserId: targetId,
        newRole,
        actorId: req.session.userId!,
        actorRole: req.session.userRole!,
      });

      await recordAuditEventCritical({
        actorId: req.session.userId ?? null,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.ROLE_CHANGED,
        entityType: 'user',
        entityId: targetId,
        metadata: { newRole: parsed.role },
      });

      res.redirect(302, `/owner/users/${targetId}?success=role-changed`);
    } catch (err) {
      if (err instanceof ZodError || err instanceof AppError) {
        const msg = err instanceof ZodError ? 'Invalid role' : err.message;
        res.redirect(302, `/owner/users/${targetId}?error=${encodeURIComponent(msg)}`);
        return;
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/users/:id/disable
// ---------------------------------------------------------------------------

ownerRouter.post(
  '/users/:id/disable',
  requirePageRole('OWNER'),
  requirePagePermission('user:disable'),
  async (req: Req, res: Res, next: Next) => {
    const targetId = paramStr(req, 'id');
    try {
      await disableUser({
        targetUserId: targetId,
        actorId: req.session.userId!,
        actorRole: req.session.userRole!,
      });
      await recordAuditEventCritical({
        actorId: req.session.userId ?? null,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.ACCOUNT_DEACTIVATED,
        entityType: 'user',
        entityId: targetId,
      });
      res.redirect(302, `/owner/users/${targetId}?success=disabled`);
    } catch (err) {
      if (err instanceof AppError) {
        res.redirect(302, `/owner/users/${targetId}?error=${encodeURIComponent(err.message)}`);
        return;
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/users/:id/reactivate
// ---------------------------------------------------------------------------

ownerRouter.post(
  '/users/:id/reactivate',
  requirePageRole('OWNER'),
  requirePagePermission('user:reactivate'),
  async (req: Req, res: Res, next: Next) => {
    const targetId = paramStr(req, 'id');
    try {
      await reactivateUser({
        targetUserId: targetId,
        actorId: req.session.userId!,
        actorRole: req.session.userRole!,
      });
      await recordAuditEventCritical({
        actorId: req.session.userId ?? null,
        actorEmail: req.session.userEmail ?? null,
        action: AuditAction.ACCOUNT_REACTIVATED,
        entityType: 'user',
        entityId: targetId,
      });
      res.redirect(302, `/owner/users/${targetId}?success=reactivated`);
    } catch (err) {
      if (err instanceof AppError) {
        res.redirect(302, `/owner/users/${targetId}?error=${encodeURIComponent(err.message)}`);
        return;
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/users/:id/revoke-sessions
// ---------------------------------------------------------------------------

ownerRouter.post(
  '/users/:id/revoke-sessions',
  requirePageRole('OWNER'),
  requirePagePermission('user:revoke_sessions'),
  async (req: Req, res: Res, next: Next) => {
    const targetId = paramStr(req, 'id');
    try {
      const count = await revokeUserSessions(
        targetId,
        req.session.userId!,
        req.session.userRole!,
      );
      res.redirect(302, `/owner/users/${targetId}?success=sessions-revoked&count=${count}`);
    } catch (err) {
      if (err instanceof AppError) {
        res.redirect(302, `/owner/users/${targetId}?error=${encodeURIComponent(err.message)}`);
        return;
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /owner/invitations
// ---------------------------------------------------------------------------

ownerRouter.get(
  '/invitations',
  requirePageRole('OWNER'),
  requirePagePermission('user:invite'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const invitations = await listPendingInvitations();
      const locals = await baseLocals(req, res);
      res.render('owner/invitations.njk', {
        ...locals,
        invitations,
        roles: ROLES.filter((r) => r !== 'OWNER'),
        error: queryStr(req, 'error'),
        success: queryStr(req, 'success'),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/invite
// ---------------------------------------------------------------------------

const inviteSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  role: z.string().refine((v) => isRole(v) && v !== 'OWNER', {
    message: 'Invalid or unauthorized role',
  }),
});

ownerRouter.post(
  '/invite',
  inviteLimiter,
  requirePageRole('OWNER'),
  requirePagePermission('user:invite'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const parsed = inviteSchema.parse(req.body);
      // Zod refine validates this is a valid non-OWNER Role
      const inviteRole = parsed.role as unknown as Role;
      await createInvitation({
        email: parsed.email,
        role: inviteRole,
        invitedByUserId: req.session.userId!,
        invitedByRole: req.session.userRole!,
      });
      res.redirect(302, `/owner/invitations?success=invited`);
    } catch (err) {
      if (err instanceof ZodError || err instanceof AppError) {
        const msg = err instanceof ZodError ? (err.errors[0]?.message ?? 'Invalid input') : err.message;
        res.redirect(302, `/owner/invitations?error=${encodeURIComponent(msg)}`);
        return;
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /owner/invitations/:id/revoke
// ---------------------------------------------------------------------------

ownerRouter.post(
  '/invitations/:id/revoke',
  requirePageRole('OWNER'),
  requirePagePermission('user:invite'),
  async (req: Req, res: Res, next: Next) => {
    const invitationId = paramStr(req, 'id');
    try {
      await revokeInvitation(invitationId, req.session.userId!);
      res.redirect(302, `/owner/invitations?success=revoked`);
    } catch (err) {
      if (err instanceof AppError) {
        res.redirect(302, `/owner/invitations?error=${encodeURIComponent(err.message)}`);
        return;
      }
      next(err);
    }
  },
);
