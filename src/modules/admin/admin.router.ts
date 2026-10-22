/**
 * Admin router — server-rendered admin shell pages.
 *
 * GET /admin          — ADMIN, EDITOR, REVIEWER
 * GET /admin/editor   — ADMIN, EDITOR
 * GET /admin/reviewer — ADMIN, REVIEWER
 *
 * Authorization is enforced server-side on every request.
 * Hiding nav links is UX only — the guard always runs.
 */

import { Router } from 'express';
import { requirePageRole } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';

export const adminRouter = Router();

// ---------------------------------------------------------------------------
// GET /admin
// ---------------------------------------------------------------------------

adminRouter.get(
  '/',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req, res, next) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;

      res.render('admin/index.njk', {
        csrfToken: generateCsrfToken(req, res),
        year: new Date().getFullYear(),
        userEmail: req.session.userEmail,
        userRole: req.session.userRole,
        displayName: user?.displayName || req.session.userEmail,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/editor
// ---------------------------------------------------------------------------

adminRouter.get(
  '/editor',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR'),
  async (req, res, next) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;

      res.render('admin/editor.njk', {
        csrfToken: generateCsrfToken(req, res),
        year: new Date().getFullYear(),
        userEmail: req.session.userEmail,
        userRole: req.session.userRole,
        displayName: user?.displayName || req.session.userEmail,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/reviewer
// ---------------------------------------------------------------------------

adminRouter.get(
  '/reviewer',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req, res, next) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;

      res.render('admin/reviewer.njk', {
        csrfToken: generateCsrfToken(req, res),
        year: new Date().getFullYear(),
        userEmail: req.session.userEmail,
        userRole: req.session.userRole,
        displayName: user?.displayName || req.session.userEmail,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ADMIN/OWNER-only function stub
adminRouter.get(
  '/settings',
  requirePageRole('OWNER', 'ADMIN'),
  (_req, res) => {
    res.status(200).json({ message: 'Admin settings — not yet implemented' });
  },
);
