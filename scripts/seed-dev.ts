#!/usr/bin/env tsx
/**
 * Development seed script — create one test user per role.
 *
 * Usage:
 *   npm run db:seed:dev
 *
 * Requirements:
 * - NODE_ENV must NOT be "production"
 * - Credentials are read from environment variables (never hard-coded)
 * - Passwords are hashed using the same Argon2id service as production
 * - Never runs automatically; must be invoked manually
 * - Never logs plaintext passwords
 *
 * Environment variables (all optional — only creates accounts that are set):
 *   DEV_OWNER_EMAIL       DEV_OWNER_PASSWORD
 *   DEV_ADMIN_EMAIL       DEV_ADMIN_PASSWORD
 *   DEV_EDITOR_EMAIL      DEV_EDITOR_PASSWORD
 *   DEV_REVIEWER_EMAIL    DEV_REVIEWER_PASSWORD
 *   DEV_USER_EMAIL        DEV_USER_PASSWORD
 *
 * NOTE: For a production OWNER bootstrap, use:
 *   npm run db:bootstrap:owner
 */

import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env before importing app modules that read env at import time
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '..', '.env') });

// ── Guard: refuse to run in production ──────────────────────────────────────
if (process.env['NODE_ENV'] === 'production') {
  console.error('❌  db:seed:dev must not run in production (NODE_ENV=production).');
  process.exit(1);
}

import { eq, sql } from 'drizzle-orm';
import { getDb, closeDatabase } from '../src/db/client.js';
import { usersTable } from '../src/db/schema/index.js';
import { hashPassword } from '../src/shared/password.js';

// ── Types ───────────────────────────────────────────────────────────────────

type SeedRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'REVIEWER' | 'USER';

interface SeedAccount {
  role: SeedRole;
  emailVar: string;
  passwordVar: string;
  displayName: string;
}

const ACCOUNTS: SeedAccount[] = [
  { role: 'OWNER',    emailVar: 'DEV_OWNER_EMAIL',    passwordVar: 'DEV_OWNER_PASSWORD',    displayName: 'Dev Owner' },
  { role: 'ADMIN',    emailVar: 'DEV_ADMIN_EMAIL',    passwordVar: 'DEV_ADMIN_PASSWORD',    displayName: 'Dev Admin' },
  { role: 'EDITOR',   emailVar: 'DEV_EDITOR_EMAIL',   passwordVar: 'DEV_EDITOR_PASSWORD',   displayName: 'Dev Editor' },
  { role: 'REVIEWER', emailVar: 'DEV_REVIEWER_EMAIL', passwordVar: 'DEV_REVIEWER_PASSWORD', displayName: 'Dev Reviewer' },
  { role: 'USER',     emailVar: 'DEV_USER_EMAIL',     passwordVar: 'DEV_USER_PASSWORD',     displayName: 'Dev User' },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const db = getDb();

  console.log('🌱  ISF development seed — creating test accounts...\n');

  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const account of ACCOUNTS) {
    const email = process.env[account.emailVar];
    const password = process.env[account.passwordVar];

    if (!email || !password) {
      console.log(`  ⏭  ${account.role}: skipped (${account.emailVar} or ${account.passwordVar} not set)`);
      skipped++;
      continue;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Prevent creating a second OWNER via seed (use bootstrap-owner for first OWNER)
    if (account.role === 'OWNER') {
      const existingOwner = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(sql`${usersTable.role} = 'OWNER' AND ${usersTable.deletedAt} IS NULL`)
        .limit(1);

      if (existingOwner.length > 0) {
        console.log(`  ⚠️  OWNER: an OWNER account already exists — skipped (use db:bootstrap:owner for first-time setup)`);
        skipped++;
        continue;
      }
    }

    // Check if user already exists
    const existing = await db
      .select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(
        sql`LOWER(${usersTable.email}) = ${normalizedEmail} AND ${usersTable.deletedAt} IS NULL`,
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`  ✓  ${account.role}: already exists <${normalizedEmail}> (skipped)`);
      skipped++;
      continue;
    }

    try {
      const passwordHash = await hashPassword(password);

      await db.insert(usersTable).values({
        email: normalizedEmail,
        passwordHash,
        displayName: account.displayName,
        role: account.role,
        // Mark email as verified for dev accounts
        emailVerifiedAt: new Date(),
      });

      // Never log the password — only confirm creation
      console.log(`  ✅  ${account.role}: created <${normalizedEmail}>`);
      created++;
    } catch (err) {
      console.error(`  ❌  ${account.role}: failed to create <${normalizedEmail}>`, err);
      errored++;
    }
  }

  console.log(`\n  Summary: ${created} created, ${skipped} skipped, ${errored} failed\n`);

  await closeDatabase();

  if (errored > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
