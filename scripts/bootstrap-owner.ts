#!/usr/bin/env tsx
/**
 * Bootstrap OWNER account — one-time setup script.
 *
 * Creates the single platform OWNER account from environment variables.
 * This script is intentionally separate from seed-dev.ts because the OWNER
 * bootstrap is a production-grade operation (run once, stored permanently).
 *
 * Usage:
 *   npm run db:bootstrap:owner
 *
 * Requirements:
 * - NODE_ENV must NOT be "production" unless --force-production flag is passed
 * - Credentials must be set in environment variables
 * - Password is hashed using Argon2id (same as production auth service)
 * - Never logs plaintext passwords or password hashes
 * - Refuses to create a second OWNER if one already exists
 *
 * Environment variables (required):
 *   BOOTSTRAP_OWNER_EMAIL     Email address for the OWNER account
 *   BOOTSTRAP_OWNER_PASSWORD  Password for the OWNER account (min 12 chars recommended)
 *
 * Optional:
 *   BOOTSTRAP_OWNER_NAME      Display name (defaults to "Platform Owner")
 *   BOOTSTRAP_FORCE           Set to "yes" to allow running in production
 */

import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '..', '.env') });

// ── Production guard ─────────────────────────────────────────────────────────
const forceFlag = process.argv.includes('--force-production') ||
                  process.env['BOOTSTRAP_FORCE'] === 'yes';

if (process.env['NODE_ENV'] === 'production' && !forceFlag) {
  console.error(
    '❌  This script must not run in production without --force-production or BOOTSTRAP_FORCE=yes.',
  );
  console.error('   This is a safety guard. Only override if you understand the risk.');
  process.exit(1);
}

import { sql } from 'drizzle-orm';
import { getDb, closeDatabase } from '../src/db/client.js';
import { usersTable } from '../src/db/schema/index.js';
import { hashPassword } from '../src/shared/password.js';

async function run(): Promise<void> {
  const email = process.env['BOOTSTRAP_OWNER_EMAIL'];
  const password = process.env['BOOTSTRAP_OWNER_PASSWORD'];
  const displayName = process.env['BOOTSTRAP_OWNER_NAME'] ?? 'Platform Owner';

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!email || !password) {
    console.error('❌  BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD must be set.');
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('❌  BOOTSTRAP_OWNER_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase().trim();

  const db = getDb();

  console.log('🔑  ISF — bootstrapping OWNER account...\n');

  // ── Check for existing OWNER ───────────────────────────────────────────────
  const existingOwners = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(
      sql`${usersTable.role} = 'OWNER' AND ${usersTable.deletedAt} IS NULL`,
    );

  if (existingOwners.length > 0) {
    console.error(
      `❌  An OWNER account already exists: <${existingOwners[0]?.email}>.`,
    );
    console.error('   There can only be one OWNER. To replace it, manually update the database.');
    process.exit(1);
  }

  // ── Check if email is already taken (any role) ────────────────────────────
  const [existingEmail] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(
      sql`LOWER(${usersTable.email}) = ${normalizedEmail} AND ${usersTable.deletedAt} IS NULL`,
    )
    .limit(1);

  if (existingEmail) {
    console.error(
      `❌  An account with email <${normalizedEmail}> already exists (role: ${existingEmail.role}).`,
    );
    console.error('   Delete or modify that account before bootstrapping OWNER.');
    process.exit(1);
  }

  // ── Create the OWNER account ───────────────────────────────────────────────
  const passwordHash = await hashPassword(password);

  await db.insert(usersTable).values({
    email: normalizedEmail,
    passwordHash,
    displayName,
    role: 'OWNER',
    // Email pre-verified — the person running this script controls the address
    emailVerifiedAt: new Date(),
  });

  // Never print password or hash
  console.log(`  ✅  OWNER account created: <${normalizedEmail}>`);
  console.log(`  Display name : ${displayName}`);
  console.log(`  Role         : OWNER`);
  console.log(
    `\n  ⚠️  Store the OWNER credentials securely. This account has full system access.\n`,
  );

  await closeDatabase();
}

run().catch((err) => {
  console.error('Bootstrap script failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
