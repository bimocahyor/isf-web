/**
 * RBAC — Roles, Permissions, and the permission map.
 *
 * Authorization throughout the application is done through named permissions,
 * never raw role checks. Role checks are only used here, in this single file.
 *
 * Role hierarchy (highest → lowest):
 *   OWNER > ADMIN > EDITOR / REVIEWER > USER
 *
 * OWNER is the bootstrap governance role. It cannot be assigned via normal
 * user management — only through the owner bootstrap command.
 * ADMIN cannot demote/delete OWNER or assign the OWNER role.
 *
 * Usage:
 *   import { hasPermission } from '../shared/rbac.js';
 *   if (!hasPermission(user.role, 'user:manage')) throw new ForbiddenError();
 */

// ---------------------------------------------------------------------------
// Role type
// ---------------------------------------------------------------------------

export const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

// ---------------------------------------------------------------------------
// Permission strings
// ---------------------------------------------------------------------------

export type Permission =
  // Governance (OWNER only)
  | 'owner:transfer'
  | 'owner:bootstrap'
  // System configuration
  | 'system:configure'
  // User management
  | 'user:list'
  | 'user:view'
  | 'user:create'
  | 'user:edit'
  | 'user:delete'
  | 'user:manage'           // umbrella: list+view+create+edit
  | 'user:change_role'      // ADMIN can change roles (except OWNER → OWNER/OWNER target)
  | 'user:assign_admin'     // OWNER only: assign/revoke ADMIN role
  | 'user:disable'
  | 'user:reactivate'
  | 'user:revoke_sessions'
  | 'user:invite'
  // Profile (own)
  | 'profile:edit'
  // Articles (CMS)
  | 'article:create'
  | 'article:edit'
  | 'article:submit_review'
  | 'article:review'
  | 'article:approve'
  | 'article:publish'
  | 'article:archive'
  // Scholarship applications
  | 'application:create'
  | 'application:submit'
  | 'application:view_own'
  | 'application:review'
  | 'application:approve'
  | 'application:reject'
  // Campaigns
  | 'campaign:create'
  | 'campaign:edit'
  | 'campaign:view'
  // Finance ledger
  | 'finance:view'
  | 'finance:create_draft'
  | 'finance:approve'
  | 'finance:post'
  | 'finance:reverse'
  | 'finance:manage_accounts'
  // Audit
  | 'audit:view';

// ---------------------------------------------------------------------------
// Role → Permissions map
// ---------------------------------------------------------------------------

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlyArray<Permission>>> = {
  /**
   * OWNER — bootstrap governance role.
   * Has all permissions plus exclusive governance controls.
   * Cannot be assigned through normal user management.
   */
  OWNER: [
    'owner:transfer',
    'owner:bootstrap',
    'system:configure',
    'user:list',
    'user:view',
    'user:create',
    'user:edit',
    'user:delete',
    'user:manage',
    'user:change_role',
    'user:assign_admin',
    'user:disable',
    'user:reactivate',
    'user:revoke_sessions',
    'user:invite',
    'profile:edit',
    'article:create',
    'article:edit',
    'article:submit_review',
    'article:review',
    'article:approve',
    'article:publish',
    'article:archive',
    'application:create',
    'application:submit',
    'application:view_own',
    'application:review',
    'application:approve',
    'application:reject',
    'campaign:create',
    'campaign:edit',
    'campaign:view',
    'finance:view',
    'finance:create_draft',
    'finance:approve',
    'finance:post',
    'finance:reverse',
    'finance:manage_accounts',
    'audit:view',
  ],

  /**
   * ADMIN — platform administrator.
   * Can manage users and roles, but CANNOT:
   *   - assign OWNER role
   *   - delete/demote OWNER users
   *   - access system configuration
   *   - transfer ownership
   */
  ADMIN: [
    'user:list',
    'user:view',
    'user:create',
    'user:edit',
    'user:delete',           // can delete users (not OWNER — enforced in service)
    'user:manage',
    'user:change_role',      // can change roles, but service enforces: not OWNER targets
    'user:disable',
    'user:reactivate',
    'user:revoke_sessions',
    'user:invite',
    'profile:edit',
    'article:create',
    'article:edit',
    'article:submit_review',
    'article:review',
    'article:approve',
    'article:publish',
    'article:archive',
    'application:review',
    'application:approve',
    'application:reject',
    'campaign:create',
    'campaign:edit',
    'campaign:view',
    'finance:view',
    'finance:create_draft',
    'finance:approve',
    'finance:post',
    'finance:reverse',
    'finance:manage_accounts',
    'audit:view',
  ],

  EDITOR: [
    'article:create',
    'article:edit',
    'article:submit_review',
    'campaign:create',
    'campaign:edit',
    'campaign:view',
    'finance:view',
    'finance:create_draft',
    'profile:edit',
  ],

  REVIEWER: [
    'article:review',
    'article:approve',
    'article:publish',
    'article:archive',
    'application:review',
    'application:approve',
    'application:reject',
    'campaign:view',
    'finance:view',
    'profile:edit',
  ],

  USER: [
    'profile:edit',
    'application:create',
    'application:submit',
    'application:view_own',
  ],
} as const;

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/**
 * Returns true if the role grants the requested permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role] as ReadonlyArray<string>;
  return perms.includes(permission);
}

// ---------------------------------------------------------------------------
// Role guards
// ---------------------------------------------------------------------------

/**
 * Returns true if the role has equal or higher privilege than the target role.
 * Used to prevent administrators from acting on users above their level.
 */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  const hierarchy: Record<Role, number> = {
    OWNER: 4,
    ADMIN: 3,
    EDITOR: 2,
    REVIEWER: 2,
    USER: 1,
  };
  return hierarchy[actorRole] > hierarchy[targetRole];
}

/**
 * Returns true if the role can be assigned by an actor with the given role.
 * OWNER role can only be assigned through the owner transfer workflow.
 */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === 'OWNER') {
    return actorRole === 'OWNER'; // only owner transfer (future)
  }
  if (targetRole === 'ADMIN') {
    return actorRole === 'OWNER'; // owner:assign_admin required
  }
  // EDITOR, REVIEWER, USER can be assigned by ADMIN or OWNER
  return actorRole === 'OWNER' || actorRole === 'ADMIN';
}
