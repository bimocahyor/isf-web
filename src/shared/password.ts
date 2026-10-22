/**
 * Password service — Argon2id hashing and verification.
 *
 * Argon2id is the OWASP-recommended algorithm for password hashing.
 * Parameters follow OWASP Cheat Sheet recommendations (2024):
 *   memory cost: 19 MiB (19456 KiB)
 *   time cost:   2 iterations
 *   parallelism: 1
 *
 * These can be tuned up on production hardware with spare memory.
 * Argon2id output is self-describing — the hash includes the parameters,
 * so future parameter changes only apply to new/changed passwords.
 */

import argon2 from 'argon2';

// ---------------------------------------------------------------------------
// Argon2id parameters (OWASP 2024 minimum recommendations)
// ---------------------------------------------------------------------------

const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19456,  // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using Argon2id.
 * The returned string is safe to store directly in the database.
 * Never log or transmit the plaintext password.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored Argon2id hash.
 * Returns true if the password matches, false otherwise.
 * Never throws on a non-matching password — only on internal errors.
 */
export async function verifyPassword(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  return argon2.verify(hash, plaintext);
}

/**
 * Returns true if the stored hash was created with parameters below
 * the current thresholds (i.e., the hash should be rehashed on next login).
 * Argon2 encodes its parameters in the hash string itself.
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}
