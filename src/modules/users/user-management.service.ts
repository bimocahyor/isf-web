/**
 * User management service — list, view, modify, disable, and revoke sessions.
 *
 * Security invariants enforced here:
 *  - OWNER accounts cannot be deleted or demoted through this service
 *  - An actor cannot change a role above their own level
 *  - Session data (passwords, hashes) is never returned
 */

import { eq, ilike, or, sql, desc } from 'drizzle-orm';
import { getDb, getPool } from '../../db/client.js';
import { usersTable } from '../../db/schema/index.js';
import { isRole, canManageRole, canAssignRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { ForbiddenError, NotFoundError, BadRequestError } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserListItem {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerifiedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

export interface UserDetail extends UserListItem {
  updatedAt: Date;
}

export interface ListUsersOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// List users
// ---------------------------------------------------------------------------

export async function listUsers(
  opts: ListUsersOptions = {},
): Promise<{ users: UserListItem[]; total: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const baseWhere = sql`${usersTable.deletedAt} IS NULL`;
  const searchWhere = opts.search
    ? or(
        ilike(usersTable.email, `%${opts.search}%`),
        ilike(usersTable.displayName, `%${opts.search}%`),
      )
    : undefined;

  const where = searchWhere ? sql`${baseWhere} AND (${searchWhere})` : baseWhere;

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(usersTable)
    .where(where);

  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      displayName: usersTable.displayName,
      role: usersTable.role,
      emailVerifiedAt: usersTable.emailVerifiedAt,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(where)
    .orderBy(desc(usersTable.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    users: rows,
    total: countResult?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Get user by ID (safe — no password hash)
// ---------------------------------------------------------------------------

export async function getUserDetail(id: string): Promise<UserDetail> {
  const db = getDb();
  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      displayName: usersTable.displayName,
      role: usersTable.role,
      emailVerifiedAt: usersTable.emailVerifiedAt,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
      updatedAt: usersTable.updatedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  return user;
}

// ---------------------------------------------------------------------------
// Change role
// ---------------------------------------------------------------------------

export interface ChangeRoleInput {
  targetUserId: string;
  newRole: Role;
  actorId: string;
  actorRole: Role;
}

export async function changeUserRole(input: ChangeRoleInput): Promise<void> {
  const db = getDb();

  if (!isRole(input.newRole)) {
    throw new BadRequestError('Invalid role');
  }

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, input.targetUserId))
    .limit(1);

  if (!target) {
    throw new NotFoundError('User not found');
  }

  // Cannot change own role
  if (target.id === input.actorId) {
    throw new ForbiddenError('You cannot change your own role');
  }

  const targetCurrentRole = isRole(target.role) ? target.role : 'USER';

  // Actor cannot act on someone at or above their own level
  if (!canManageRole(input.actorRole, targetCurrentRole)) {
    throw new ForbiddenError('You cannot modify a user with a higher or equal role');
  }

  // Check if actor can assign the new role
  if (!canAssignRole(input.actorRole, input.newRole)) {
    throw new ForbiddenError(
      `You do not have permission to assign the ${input.newRole} role`,
    );
  }

  // Prevent demotion of OWNER
  if (targetCurrentRole === 'OWNER') {
    throw new ForbiddenError('The OWNER role cannot be changed through user management');
  }

  await db
    .update(usersTable)
    .set({ role: input.newRole, updatedAt: new Date() })
    .where(eq(usersTable.id, input.targetUserId));
}

// ---------------------------------------------------------------------------
// Disable / reactivate account
// ---------------------------------------------------------------------------

export interface DisableUserInput {
  targetUserId: string;
  actorId: string;
  actorRole: Role;
}

export async function disableUser(input: DisableUserInput): Promise<void> {
  const db = getDb();

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, input.targetUserId))
    .limit(1);

  if (!target) throw new NotFoundError('User not found');
  if (target.id === input.actorId) throw new ForbiddenError('You cannot disable your own account');

  const targetRole = isRole(target.role) ? target.role : 'USER';

  if (targetRole === 'OWNER') {
    throw new ForbiddenError('The OWNER account cannot be disabled through user management');
  }

  if (!canManageRole(input.actorRole, targetRole)) {
    throw new ForbiddenError('You cannot disable a user with a higher or equal role');
  }

  if (!target.isActive) {
    throw new BadRequestError('This account is already disabled');
  }

  await db
    .update(usersTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(usersTable.id, input.targetUserId));
}

export async function reactivateUser(input: DisableUserInput): Promise<void> {
  const db = getDb();

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, input.targetUserId))
    .limit(1);

  if (!target) throw new NotFoundError('User not found');

  const targetRole = isRole(target.role) ? target.role : 'USER';

  if (!canManageRole(input.actorRole, targetRole)) {
    throw new ForbiddenError('You cannot reactivate a user with a higher or equal role');
  }

  if (target.isActive) {
    throw new BadRequestError('This account is already active');
  }

  await db
    .update(usersTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(usersTable.id, input.targetUserId));
}

// ---------------------------------------------------------------------------
// Revoke sessions
// ---------------------------------------------------------------------------

export async function revokeUserSessions(
  targetUserId: string,
  actorId: string,
  actorRole: Role,
): Promise<number> {
  const db = getDb();
  const pool = getPool();

  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, targetUserId))
    .limit(1);

  if (!target) throw new NotFoundError('User not found');

  const targetRole = isRole(target.role) ? target.role : 'USER';

  if (targetRole === 'OWNER' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only the OWNER can revoke their own sessions');
  }

  if (!canManageRole(actorRole, targetRole) && actorId !== targetUserId) {
    throw new ForbiddenError('You cannot revoke sessions for a user with a higher or equal role');
  }

  const result = await pool.query<{ id: string }>(
    `DELETE FROM sessions WHERE sess->>'userId' = $1`,
    [targetUserId],
  );

  return result.rowCount ?? 0;
}
