/**
 * Invitation service — create, accept, revoke, and validate invitations.
 *
 * Invitation flow:
 *   1. Owner/Admin creates an invitation (email + role)
 *   2. A secure one-time link is sent to the invited email
 *   3. The invited user opens the link, sets their password
 *   4. Account is created with the specified role and email verified
 *   5. Token is marked as accepted (single-use)
 *
 * Token security:
 *   Raw token: 32 random bytes, base64url-encoded — goes in email link only.
 *   Token hash: SHA-256(rawToken) as hex — stored in database.
 */

import { eq, sql, and, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { usersTable, invitationsTable } from '../../db/schema/index.js';
import { generateSecureToken, hashToken, expiresInHours } from '../../shared/tokens.js';
import { hashPassword } from '../../shared/password.js';
import { sendInvitationEmail } from '../../shared/mailer.js';
import { isRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../config/index.js';

// ---------------------------------------------------------------------------
// Create invitation
// ---------------------------------------------------------------------------

export interface CreateInvitationInput {
  email: string;
  role: Role;
  invitedByUserId: string;
  invitedByRole: Role;
}

export interface CreateInvitationResult {
  invitationId: string;
  email: string;
  role: Role;
}

/**
 * Create a new invitation for the given email + role.
 * Sends the invitation email with the secure link.
 *
 * Rules:
 *  - ADMIN cannot invite to OWNER or ADMIN roles (only OWNER can assign ADMIN)
 *  - Email must not belong to an existing active account
 *  - Previous pending invitations for this email are superseded
 */
export async function createInvitation(
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const db = getDb();
  const normalizedEmail = input.email.toLowerCase().trim();

  // Permission check: only OWNER can invite to ADMIN role
  if (input.role === 'OWNER') {
    throw new ForbiddenError('The OWNER role cannot be assigned via invitation');
  }
  if (input.role === 'ADMIN' && input.invitedByRole !== 'OWNER') {
    throw new ForbiddenError('Only the OWNER can invite users to the ADMIN role');
  }

  // Check for existing active account
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      sql`LOWER(${usersTable.email}) = ${normalizedEmail} AND ${usersTable.deletedAt} IS NULL`,
    )
    .limit(1);

  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  // Revoke any existing pending invitations for this email
  await db
    .update(invitationsTable)
    .set({ revokedAt: new Date(), revokedBy: input.invitedByUserId })
    .where(
      and(
        eq(invitationsTable.email, normalizedEmail),
        isNull(invitationsTable.acceptedAt),
        isNull(invitationsTable.revokedAt),
      ),
    );

  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);

  const [inv] = await db
    .insert(invitationsTable)
    .values({
      email: normalizedEmail,
      role: input.role,
      invitedBy: input.invitedByUserId,
      tokenHash,
      expiresAt: expiresInHours(72),
    })
    .returning({ id: invitationsTable.id });

  if (!inv) {
    throw new Error('Failed to create invitation');
  }

  const inviteUrl = `${env.APP_BASE_URL}/auth/accept-invitation?token=${rawToken}`;
  const sent = await sendInvitationEmail(normalizedEmail, inviteUrl, input.role);
  if (!sent) {
    logger.warn({ invitationId: inv.id }, 'Invitation email delivery failed');
  }

  return { invitationId: inv.id, email: normalizedEmail, role: input.role };
}

// ---------------------------------------------------------------------------
// Validate invitation token (for the accept form GET)
// ---------------------------------------------------------------------------

export interface InvitationTokenInfo {
  invitationId: string;
  email: string;
  role: Role;
}

export async function getInvitationByToken(
  rawToken: string,
): Promise<InvitationTokenInfo> {
  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [record] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    throw new BadRequestError('Invalid or expired invitation link');
  }

  if (record.acceptedAt !== null) {
    throw new BadRequestError('This invitation has already been used');
  }

  if (record.revokedAt !== null) {
    throw new BadRequestError('This invitation has been revoked');
  }

  if (record.expiresAt < now) {
    throw new BadRequestError('This invitation has expired');
  }

  const role = isRole(record.role) ? record.role : 'USER';

  return {
    invitationId: record.id,
    email: record.email,
    role,
  };
}

// ---------------------------------------------------------------------------
// Accept invitation — create account
// ---------------------------------------------------------------------------

export interface AcceptInvitationInput {
  rawToken: string;
  password: string;
  displayName?: string;
}

export interface AcceptInvitationResult {
  userId: string;
  email: string;
  role: Role;
}

export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const db = getDb();
  const tokenHash = hashToken(input.rawToken);
  const now = new Date();

  const [record] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    throw new BadRequestError('Invalid or expired invitation link');
  }
  if (record.acceptedAt !== null) {
    throw new BadRequestError('This invitation has already been used');
  }
  if (record.revokedAt !== null) {
    throw new BadRequestError('This invitation has been revoked');
  }
  if (record.expiresAt < now) {
    throw new BadRequestError('This invitation has expired');
  }

  // Check email not already taken
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      sql`LOWER(${usersTable.email}) = ${record.email} AND ${usersTable.deletedAt} IS NULL`,
    )
    .limit(1);

  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const role = isRole(record.role) ? record.role : 'USER';

  const [user] = await db
    .insert(usersTable)
    .values({
      email: record.email,
      passwordHash,
      displayName: input.displayName?.trim() ?? '',
      role,
      // Email is implicitly verified — the invitation was sent to this address
      emailVerifiedAt: now,
    })
    .returning({ id: usersTable.id });

  if (!user) {
    throw new Error('Failed to create user from invitation');
  }

  // Mark invitation as accepted
  await db
    .update(invitationsTable)
    .set({ acceptedAt: now, acceptedBy: user.id })
    .where(eq(invitationsTable.id, record.id));

  return { userId: user.id, email: record.email, role };
}

// ---------------------------------------------------------------------------
// Revoke invitation
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  invitationId: string,
  revokedByUserId: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();

  const [record] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.id, invitationId))
    .limit(1);

  if (!record) {
    throw new BadRequestError('Invitation not found');
  }
  if (record.acceptedAt !== null) {
    throw new BadRequestError('Cannot revoke an already-accepted invitation');
  }
  if (record.revokedAt !== null) {
    throw new BadRequestError('This invitation is already revoked');
  }

  await db
    .update(invitationsTable)
    .set({ revokedAt: now, revokedBy: revokedByUserId })
    .where(eq(invitationsTable.id, invitationId));
}

// ---------------------------------------------------------------------------
// List pending invitations
// ---------------------------------------------------------------------------

export interface InvitationListItem {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
  invitedByEmail: string | null;
}

export async function listPendingInvitations(): Promise<InvitationListItem[]> {
  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({
      id: invitationsTable.id,
      email: invitationsTable.email,
      role: invitationsTable.role,
      expiresAt: invitationsTable.expiresAt,
      createdAt: invitationsTable.createdAt,
      invitedByEmail: usersTable.email,
    })
    .from(invitationsTable)
    .leftJoin(usersTable, eq(invitationsTable.invitedBy, usersTable.id))
    .where(
      and(
        isNull(invitationsTable.acceptedAt),
        isNull(invitationsTable.revokedAt),
        sql`${invitationsTable.expiresAt} > ${now}`,
      ),
    )
    .orderBy(invitationsTable.createdAt);

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    invitedByEmail: r.invitedByEmail ?? null,
  }));
}
