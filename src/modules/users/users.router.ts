/**
 * Users router — authenticated user profile endpoint.
 *
 * Phase 1 provides only GET /api/v1/users/me.
 * User management endpoints (list, view, edit, role change) are Phase 2+.
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import { NotFoundError } from '../../shared/errors.js';

export const usersRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/users/me — return the full authenticated user profile
// ---------------------------------------------------------------------------

usersRouter.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const user = await getUserById(req.session.userId!);

    if (!user) {
      // Session references a user that no longer exists — invalid session
      req.session.destroy(() => {});
      return next(new NotFoundError('User not found'));
    }

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    });
  } catch (err) {
    next(err);
  }
});
