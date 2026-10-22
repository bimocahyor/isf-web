/**
 * Database schema — Phase 1: Users, Sessions, Audit Logs
 *
 * All tables use:
 * - UUID primary keys (gen_random_uuid via pgcrypto)
 * - TIMESTAMPTZ (never plain TIMESTAMP — all timestamps must be timezone-aware)
 * - snake_case column names
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  inet,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const usersTable = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull().default(''),
    role: text('role').notNull().default('USER'),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (t) => [
    // Partial unique index: email uniqueness only among non-deleted accounts.
    // The full partial index (WHERE deleted_at IS NULL) is in the SQL migration.
    // Drizzle schema uses a plain unique index for type-checking purposes.
    uniqueIndex('users_email_unique').on(t.email),
    index('users_email_idx').on(t.email),
    index('users_role_idx').on(t.role),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;

// ---------------------------------------------------------------------------
// sessions — connect-pg-simple compatible
// Drizzle schema mirrors the table created by the SQL migration.
// connect-pg-simple manages this table directly; we declare it for type safety.
// ---------------------------------------------------------------------------

export const sessionsTable = pgTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    sess: jsonb('sess').notNull(),
    expire: timestamp('expire', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('sessions_expire_idx').on(t.expire)],
);

// ---------------------------------------------------------------------------
// audit_logs
// ---------------------------------------------------------------------------

export const auditLogsTable = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogsTable.$inferSelect;
export type NewAuditLog = typeof auditLogsTable.$inferInsert;

// ---------------------------------------------------------------------------
// email_verification_tokens
// ---------------------------------------------------------------------------

export const emailVerificationTokensTable = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('evt_user_id_idx').on(t.userId),
    index('evt_expires_at_idx').on(t.expiresAt),
  ],
);

export type EmailVerificationToken = typeof emailVerificationTokensTable.$inferSelect;

// ---------------------------------------------------------------------------
// password_reset_tokens
// ---------------------------------------------------------------------------

export const passwordResetTokensTable = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('prt_user_id_idx').on(t.userId),
    index('prt_expires_at_idx').on(t.expiresAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------

export const invitationsTable = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    role: text('role').notNull().default('USER'),
    invitedBy: uuid('invited_by'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    acceptedBy: uuid('accepted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: uuid('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('inv_token_hash_idx').on(t.tokenHash),
    index('inv_email_idx').on(t.email),
    index('inv_invited_by_idx').on(t.invitedBy),
    index('inv_expires_at_idx').on(t.expiresAt),
  ],
);

export type Invitation = typeof invitationsTable.$inferSelect;
