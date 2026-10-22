# ADR-004: Role-Based Access Control (RBAC)

**Status:** Accepted  
**Date:** 2025

## Decision

Permission-based authorization using named permissions mapped to roles.
Role checks are never scattered through business logic — all authorization flows through an `authorize(permission)` middleware.

## Roles

| Role | Description |
|------|-------------|
| `ADMIN` | Full system access |
| `EDITOR` | Create and manage content; view financial records; create financial drafts |
| `REVIEWER` | Review scholarship applications and CMS articles |
| `USER` | Authenticated applicant — can submit applications, view own data |

A user has exactly one role at MVP. Future phases may introduce a role-assignment join table for multi-role support without changing the permission check logic.

## Permission Model

Permissions are named strings (e.g., `article:publish`, `application:review`).

A `ROLE_PERMISSIONS` map defines which roles hold which permissions:

```typescript
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: ['*'],  // all permissions
  EDITOR: [
    'article:create', 'article:edit', 'article:submit_review',
    'campaign:create', 'campaign:edit',
    'finance:view', 'finance:create_draft',
  ],
  REVIEWER: [
    'article:review', 'article:approve', 'article:publish', 'article:archive',
    'application:review', 'application:approve', 'application:reject',
  ],
  USER: [
    'profile:edit',
    'application:create', 'application:submit',
    'application:view_own',
  ],
};
```

## Finance-Specific Permissions

Financial permissions distinguish between viewing, drafting, and posting:

| Permission | Description |
|------------|-------------|
| `finance:view` | View ledger accounts and journal entries |
| `finance:create_draft` | Create draft journal transactions |
| `finance:approve` | Approve a draft transaction (must be different user from creator) |
| `finance:post` | Post an approved transaction to the ledger |
| `finance:reverse` | Create a reversal transaction |
| `finance:manage_accounts` | Create and manage ledger accounts |

EDITOR may hold `finance:view` and `finance:create_draft` but NOT `finance:approve`, `finance:post`, or `finance:reverse`.

Maker-checker: the user who creates a draft transaction cannot approve their own transaction.
This is enforced in the service layer, not the middleware layer.

## Authorization Middleware Pattern

```typescript
// Usage in routes:
router.post('/applications/:id/approve',
  authorize('application:approve'),
  applicationController.approve
);

// authorize() factory:
function authorize(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) throw new UnauthorizedError();
    if (!hasPermission(req.session.role, permission)) throw new ForbiddenError();
    next();
  };
}
```

## IDOR Prevention

**UUID is NOT an IDOR defense.**

Every resource access must verify both:
1. The user has the required permission (role check)
2. The user owns or is authorized to access the specific resource (ownership check)

Ownership checks are enforced in the service layer, not the route middleware.

## Database Tables (Phase 1)

```
users (id, email, password_hash, role, email_verified_at, created_at, deleted_at)
```

Future extension (if multi-role needed):
```
roles (id, name)
permissions (id, name, description)
role_permissions (role_id, permission_id)
user_roles (user_id, role_id, granted_at, granted_by, expires_at)
```

## Implementation Phase

Core RBAC: Phase 1 (alongside auth).  
Finance permissions: Phase 6 (alongside ledger module).
