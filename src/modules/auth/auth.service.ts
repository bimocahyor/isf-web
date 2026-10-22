/**
 * Auth service — registration, login, email verification, password reset.
 *
 * This service layer owns all auth business rules.
 * It never directly touches the session object — that is the router's job.
 * The service returns typed results; the router decides the HTTP response.
 *
 * Token security model:
 * - Raw token: 32 random bytes, base64url-encoded. Goes in the email link only.
 * - Token hash: SHA-256(rawToken) as hex. Stored in the database.
 * - On redemption: hash(submitted token) is compared to stored hash.
 * - A database breach does not expose usable tokens.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '../../db/client.js';
import {
  usersTable,
  emailVerificationTokensTable,
  passwordResetTokensTable,
} from '../../db/schema/index.js';
import type { User } from '../../db/schema/index.js';
import { hashPassword, verifyPassword, needsRehash } from '../../shared/password.js';
import { generateSecureToken, hashToken, expiresInHours } from '../../shared/tokens.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../../shared/mailer.js';
import { isRole } from '../../shared/rbac.js';
import {
  ConflictError,
  UnauthorizedError,
  BadRequestError,
} from '../../shared/errors.js';
import { recordAuditEvent, recordAuditEventCritical, AuditAction } from '../../shared/audit.js';
import { logger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface RegisterResult {
  user: Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'createdAt'>;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  user: Pick<User, 'id' | 'email' | 'displayName' | 'role'>;
  needsRehash: boolean;
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Create a new USER-role account, then issue an email verification token.
 * Throws ConflictError if the email is already registered.
 */
export async function register(input: RegisterInput): Promise<RegisterResult> {
  const db = getDb();
  const normalizedEmail = input.email.toLowerCase().trim();

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      sql`LOWER(${usersTable.email}) = ${normalizedEmail} AND ${usersTable.deletedAt} IS NULL`,
    )
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  const [created] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      passwordHash,
      displayName: input.displayName?.trim() ?? '',
      role: 'USER',
    })
    .returning({
      id: usersTable.id,
      email: usersTable.email,
      displayName: usersTable.displayName,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    });

  if (!created) {
    throw new Error('Registration failed: no row returned from insert');
  }

  // Issue verification token and send email (best-effort — failure does not
  // block account creation).
  try {
    const rawToken = await _issueEmailVerificationToken(db, created.id);
    const sent = await sendVerificationEmail(created.email, rawToken);
    if (!sent) {
      logger.warn({ userId: created.id }, 'Verification email delivery failed at registration');
    }
    recordAuditEvent({
      actorId: created.id,
      actorEmail: created.email,
      action: AuditAction.EMAIL_VERIFICATION_SENT,
      entityType: 'user',
      entityId: created.id,
    });
  } catch (err) {
    // Log but do not fail — user can request re-verification later
    logger.error({ err, userId: created.id }, 'Failed to issue email verification token');
  }

  return { user: created };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Verify credentials and return the authenticated user.
 * Never reveals whether the email exists (timing-safe).
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const db = getDb();
  const normalizedEmail = input.email.toLowerCase().trim();

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  // Always run verifyPassword to prevent timing-based email enumeration.
  const DUMMY_HASH =
    '$argon2id$v=19$m=19456,t=2,p=1$dummysalt000000000000000$dummyhash00000000000000000000000000000';

  const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
  const passwordValid = await verifyPassword(hashToVerify, input.password);

  if (!user || !passwordValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (!user.isActive || user.deletedAt !== null) {
    throw new UnauthorizedError('This account is not active');
  }

  const shouldRehash = needsRehash(user.passwordHash);
  if (shouldRehash) {
    const newHash = await hashPassword(input.password);
    await db
      .update(usersTable)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
  }

  const role = isRole(user.role) ? user.role : 'USER';

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role,
    },
    needsRehash: false,
  };
}

// ---------------------------------------------------------------------------
// Get user by ID (safe — no password hash returned)
// ---------------------------------------------------------------------------

export async function getUserById(
  id: string,
): Promise<Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'emailVerifiedAt' | 'createdAt'> | null> {
  const db = getDb();
  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      displayName: usersTable.displayName,
      role: usersTable.role,
      emailVerifiedAt: usersTable.emailVerifiedAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);

  return user ?? null;
}

// ---------------------------------------------------------------------------
// Email verification — internal token issuance
// ---------------------------------------------------------------------------

/**
 * Delete any existing pending tokens for this user, issue a new one.
 * Returns the raw token (to be embedded in the email link).
 * Stores only the SHA-256 hash in the database.
 */
async function _issueEmailVerificationToken(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<string> {
  // Remove any existing pending tokens for this user
  await db
    .delete(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.userId, userId));

  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);

  await db.insert(emailVerificationTokensTable).values({
    userId,
    tokenHash,
    expiresAt: expiresInHours(24),
  });

  return rawToken;
}

// ---------------------------------------------------------------------------
// Email verification — public: create token (for re-send)
// ---------------------------------------------------------------------------

export async function createEmailVerificationToken(userId: string): Promise<void> {
  const db = getDb();

  // Verify user exists and is not already verified
  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    throw new BadRequestError('User not found');
  }
  if (user.emailVerifiedAt !== null) {
    // Already verified — not an error, just a no-op
    return;
  }

  const rawToken = await _issueEmailVerificationToken(db, userId);
  const sent = await sendVerificationEmail(user.email, rawToken);
  if (!sent) {
    logger.warn({ userId }, 'Verification email re-send delivery failed');
  }
}

// ---------------------------------------------------------------------------
// Email verification — verify a submitted token
// ---------------------------------------------------------------------------

export interface VerifyEmailResult {
  userId: string;
}

/**
 * Verify a submitted raw token.
 * Throws BadRequestError on invalid, expired, or already-used token.
 * On success: sets email_verified_at, deletes the token.
 */
export async function verifyEmailToken(rawToken: string): Promise<VerifyEmailResult> {
  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [record] = await db
    .select()
    .from(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    throw new BadRequestError('Invalid or expired verification token');
  }

  if (record.expiresAt < now) {
    // Clean up expired token
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.id, record.id));
    throw new BadRequestError('Invalid or expired verification token');
  }

  // Mark email as verified and remove the token (single-use)
  await db
    .update(usersTable)
    .set({ emailVerifiedAt: now, updatedAt: now })
    .where(eq(usersTable.id, record.userId));

  await db
    .delete(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.id, record.id));

  return { userId: record.userId };
}

// ---------------------------------------------------------------------------
// Password reset — create token
// ---------------------------------------------------------------------------

/**
 * Create a password reset token for the given email.
 * If the email does not exist, returns silently (no error) — this is by design
 * to prevent email enumeration via the forgot-password endpoint.
 *
 * Invalidates any previous unused tokens for the user before issuing a new one.
 */
export async function createPasswordResetToken(
  email: string,
  ipAddress: string | null,
): Promise<void> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, isActive: usersTable.isActive, deletedAt: usersTable.deletedAt })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  // Silently return if user not found or inactive — no enumeration
  if (!user || !user.isActive || user.deletedAt !== null) {
    return;
  }

  // Invalidate all previous reset tokens for this user
  await db
    .delete(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.userId, user.id));

  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);

  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash,
    expiresAt: expiresInHours(1),
  });

  const sent = await sendPasswordResetEmail(user.email, rawToken);
  if (!sent) {
    logger.warn({ userId: user.id }, 'Password reset email delivery failed');
  }

  await recordAuditEventCritical({
    actorId: user.id,
    actorEmail: user.email,
    action: AuditAction.PASSWORD_RESET_REQUESTED,
    entityType: 'user',
    entityId: user.id,
    ipAddress,
  });
}

// ---------------------------------------------------------------------------
// Password reset — consume token
// ---------------------------------------------------------------------------

export interface ConsumeResetResult {
  userId: string;
}

/**
 * Validate a reset token and set a new password.
 *
 * Throws BadRequestError for: invalid token, expired token, already-used token.
 *
 * On success:
 * - Marks the token as used (single-use enforcement via used_at timestamp)
 * - Updates password hash using Argon2id
 * - Deletes all other sessions for the user (session invalidation)
 */
export async function consumePasswordResetToken(
  rawToken: string,
  newPassword: string,
): Promise<ConsumeResetResult> {
  const db = getDb();
  const pool = getPool();
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [record] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    throw new BadRequestError('Invalid or expired password reset token');
  }

  // Check expiry
  if (record.expiresAt < now) {
    await db
      .delete(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.id, record.id));
    throw new BadRequestError('Invalid or expired password reset token');
  }

  // Check single-use: if used_at is already set, reject
  if (record.usedAt !== null) {
    throw new BadRequestError('This password reset token has already been used');
  }

  const newHash = await hashPassword(newPassword);

  // Mark token as used
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: now })
    .where(eq(passwordResetTokensTable.id, record.id));

  // Update password
  await db
    .update(usersTable)
    .set({ passwordHash: newHash, updatedAt: now })
    .where(eq(usersTable.id, record.userId));

  // Invalidate all active sessions for this user by deleting them from the
  // sessions table. connect-pg-simple stores sessions as JSON in the `sess`
  // column; we match on the userId stored in the session data.
  //
  // Note: this invalidates sessions on OTHER devices. The current session
  // (if any) is handled separately in the router after this call returns.
  await pool.query(
    `DELETE FROM sessions WHERE sess->>'userId' = $1`,
    [record.userId],
  );

  return { userId: record.userId };
}
