#!/usr/bin/env tsx
/**
 * Development-only password reset utility.
 *
 * Resets the password for a single account by email without touching any
 * other fields (user ID, role, verification state, audit history).
 *
 * Usage:
 *   npm run db:reset-dev-password -- --email=someone@example.com --password=NewPassword123!
 *
 *   Or supply the password via env var to avoid shell history:
 *   DEV_RESET_PASSWORD=NewPassword123! npm run db:reset-dev-password -- --email=someone@example.com
 *
 * What it does:
 *   1. Refuses to run when NODE_ENV=production
 *   2. Finds exactly one matching (non-deleted) account
 *   3. Reports the current role — does NOT change it
 *   4. Hashes the new password with Argon2id
 *   5. UPDATEs only the password_hash column
 *   6. Revokes all active sessions for that user
 *   7. Writes an audit event
 *   8. Never prints plaintext passwords or hashes
 */

import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env BEFORE any app module is imported (app modules read env at load time)
config({ path: path.resolve(__dirname, '..', '.env') });

// ── Production guard ──────────────────────────────────────────────────────────
if (process.env['NODE_ENV'] === 'production') {
  console.error('❌  db:reset-dev-password must not run in production (NODE_ENV=production).');
  process.exit(1);
}

// ── Parse arguments ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const found = args.find((a) => a.startsWith(flag));
  return found ? found.slice(flag.length) : undefined;
}

const emailArg = getArg('email');
const passwordArg = getArg('password') ?? process.env['DEV_RESET_PASSWORD'];

if (!emailArg) {
  console.error('❌  --email=<address> is required.');
  console.error('   Usage: npm run db:reset-dev-password -- --email=you@example.com --password=NewPass123!');
  console.error('   Or:    DEV_RESET_PASSWORD=NewPass123! npm run db:reset-dev-password -- --email=you@example.com');
  process.exit(1);
}

if (!passwordArg) {
  console.error('❌  New password is required.');
  console.error('   Provide via --password=<value> or the DEV_RESET_PASSWORD environment variable.');
  process.exit(1);
}

if (passwordArg.length < 8) {
  console.error('❌  Password must be at least 8 characters.');
  process.exit(1);
}

// ── Dynamic imports — MUST come after dotenv.config() ────────────────────────
const { getDb, getPool, closeDatabase } = await import('../src/db/client.js');
const { usersTable } = await import('../src/db/schema/index.js');
const { hashPassword } = await import('../src/shared/password.js');
const { recordAuditEventCritical, AuditAction } = await import('../src/shared/audit.js');
const { sql, eq } = await import('drizzle-orm');

// ── Main ──────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  const db = getDb();
  const pool = getPool();
  const normalizedEmail = emailArg!.toLowerCase().trim();

  console.log(`\n🔧  ISF dev password reset for: <${normalizedEmail}>\n`);

  // 1. Find the account
  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
      emailVerifiedAt: usersTable.emailVerifiedAt,
      isActive: usersTable.isActive,
    })
    .from(usersTable)
    .where(sql`LOWER(${usersTable.email}) = ${normalizedEmail} AND ${usersTable.deletedAt} IS NULL`)
    .limit(1);

  if (!user) {
    console.error(`❌  No active account found for: <${normalizedEmail}>`);
    await closeDatabase();
    process.exit(1);
  }

  // 2. Report current state — never print hash
  console.log('  User ID       :', user.id);
  console.log('  Email         :', user.email);
  console.log('  Role          :', user.role, '← will be preserved unchanged');
  console.log('  Email verified:', user.emailVerifiedAt
    ? user.emailVerifiedAt.toISOString()
    : 'NOT VERIFIED (preserved as-is)');
  console.log('  Account active:', user.isActive);

  // 3. Hash the new password
  const newHash = await hashPassword(passwordArg!);

  // 4. Update ONLY the password hash — all other columns untouched
  await db
    .update(usersTable)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  console.log('\n  ✅  Password hash updated (Argon2id)');

  // 5. Revoke all active sessions for this user
  const revokeResult = await pool.query(
    `DELETE FROM sessions WHERE sess->>'userId' = $1`,
    [user.id],
  );
  const revokedCount = revokeResult.rowCount ?? 0;
  console.log(`  ✅  Sessions revoked: ${revokedCount}`);

  // 6. Write audit event
  await recordAuditEventCritical({
    actorId: user.id,
    actorEmail: user.email,
    action: AuditAction.PASSWORD_CHANGED,
    entityType: 'user',
    entityId: user.id,
    metadata: { method: 'dev_reset_tool', preservedRole: user.role },
  });
  console.log('  ✅  Audit event recorded');

  console.log('\n─────────────────────────────────────────');
  console.log('  Role (unchanged) :', user.role);
  console.log('  User ID          :', user.id);
  console.log('  Sessions revoked :', revokedCount);
  console.log('─────────────────────────────────────────');
  console.log('\n  Sign in at: http://localhost:3000/auth/login');
  console.log('  Email     :', user.email);
  console.log('  (use the password you provided — it is NOT stored in plaintext)\n');

  await closeDatabase();
}

run().catch((err) => {
  console.error('Reset script failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
