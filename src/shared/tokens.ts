/**
 * Secure token utilities.
 *
 * Used for email verification and password reset tokens.
 *
 * Design:
 * - Raw token: 32 cryptographically random bytes, URL-safe base64 encoded.
 *   This is what goes into the email link. It is NEVER stored in the database.
 * - Token hash: SHA-256 of the raw token (hex). This is what the database stores.
 *
 * On verification, the submitted raw token is hashed and compared against the
 * stored hash. If they match, the token is valid.
 *
 * This means a database breach does not expose usable tokens.
 */

import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure random token.
 * Returns a URL-safe base64 string (44 characters for 32 bytes).
 */
export function generateSecureToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/**
 * Hash a raw token using SHA-256.
 * Returns a lowercase hex string.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// ---------------------------------------------------------------------------
// Expiry helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Date object N hours from now.
 */
export function expiresInHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1_000);
}
