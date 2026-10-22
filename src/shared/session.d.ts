/**
 * Express session type augmentation.
 *
 * Extends the express-session SessionData interface so that TypeScript
 * knows about the fields our application stores in the session.
 *
 * This file must be imported at least once before any session usage —
 * it is imported in src/app/index.ts.
 */

import type { Role } from './rbac.js';

declare module 'express-session' {
  interface SessionData {
    /** Authenticated user's ID (UUID) */
    userId: string;
    /** Authenticated user's email (snapshot at login) */
    userEmail: string;
    /** Authenticated user's role (snapshot at login, refreshed on role change) */
    userRole: Role;
    /** Timestamp (ms) when the session was created */
    createdAt: number;
  }
}

// This file has no runtime exports — it's purely a type augmentation.
export {};
