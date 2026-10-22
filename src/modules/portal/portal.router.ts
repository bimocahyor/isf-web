/**
 * Portal router — authenticated user dashboard.
 *
 * GET /portal — accessible to all authenticated users (any role).
 */

import { Router } from 'express';
import { requirePageAuth } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';

export const portalRouter = Router();

portalRouter.get('/', requirePageAuth(), async (req, res, next) => {
  try {
    // Fetch current display name from DB (not stored in session)
    const user = req.session.userId
      ? await getUserById(req.session.userId)
      : null;

    res.render('portal/index.njk', {
      csrfToken: generateCsrfToken(req, res),
      year: new Date().getFullYear(),
      userEmail: req.session.userEmail,
      userRole: req.session.userRole,
      displayName: user?.displayName || req.session.userEmail,
    });
  } catch (err) {
    next(err);
  }
});
