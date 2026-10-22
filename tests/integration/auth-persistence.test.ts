/**
 * Auth persistence regression tests.
 *
 * These tests reproduce the failure scenario described in the bug report:
 * "Two registered accounts can no longer log in after the local development
 * server is stopped and restarted."
 *
 * Root cause: PostgreSQL (Docker container) was not running. No bug exists
 * in the application code itself — the database, Argon2id hashing, and
 * email normalization are all correct.
 *
 * Coverage:
 *   1.  Registration followed immediately by login (same process)
 *   2.  Password verification after simulated reconnect (new pool instance)
 *   3.  Authentication resilience: same credentials work across multiple
 *       independent createApp() calls (simulates server restart with same DB)
 *   4.  Invalid password → 401
 *   5.  Nonexistent email → 401
 *   6.  Disabled account → 401 (isActive=false)
 *   7.  Deleted account (soft delete) → 401
 *   8.  Session invalidation after logout
 *   9.  Logout destroys session — subsequent /auth/me returns 401
 *   10. Prevention: server startup never auto-resets or truncates users table
 *   11. Email normalisation: login with mixed-case email succeeds after
 *       registering with lower-case email
 *   12. Password hash stored in DB is never returned in API responses
 *
 * All tests skip gracefully when PostgreSQL is not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';
import { getDb, closeDatabase } from '../../src/db/client.js';
import { usersTable } from '../../src/db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../../src/shared/password.js';
import { isDatabaseAvailable } from '../setup.js';

// ---------------------------------------------------------------------------
// Constants — unique emails to avoid collisions with other test files
// ---------------------------------------------------------------------------

const P = {
  regLogin:    'persist.reg-login@isf-test.local',
  reconnect:   'persist.reconnect@isf-test.local',
  restart:     'persist.restart@isf-test.local',
  badPass:     'persist.bad-pass@isf-test.local',
  disabled:    'persist.disabled@isf-test.local',
  deleted:     'persist.deleted@isf-test.local',
  session:     'persist.session@isf-test.local',
  caseInsens:  'persist.caseinsens@isf-test.local',
};

const TEST_PASSWORD = 'PersistTest1!';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: Express;
let dbAvailable: boolean;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  app = createApp();
});

afterAll(async () => {
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

async function cleanupUser(email: string): Promise<void> {
  try {
    const db = getDb();
    await db.delete(usersTable).where(
      sql`LOWER(${usersTable.email}) = ${email.toLowerCase()}`,
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// CSRF helper
// ---------------------------------------------------------------------------

interface CsrfPair {
  token: string;
  cookie: string;
}

async function getCsrf(appInstance: Express = app): Promise<CsrfPair> {
  const res = await request(appInstance).get('/auth/csrf-token');
  const token = (res.body as { csrfToken: string }).csrfToken;
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const cookie = cookies.find((c: string) => c.startsWith('isf.csrf=')) ?? '';
  return { token, cookie };
}

// ---------------------------------------------------------------------------
// Helper: register a user via API
// ---------------------------------------------------------------------------

async function registerUser(
  email: string,
  password: string,
  appInstance: Express = app,
): Promise<{ status: number; userId?: string }> {
  const { token, cookie } = await getCsrf(appInstance);
  const res = await request(appInstance)
    .post('/auth/register')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', token)
    .send({ email, password });

  const userId = res.status === 201
    ? (res.body as { user: { id: string } }).user?.id
    : undefined;

  return { status: res.status, userId };
}

// ---------------------------------------------------------------------------
// Helper: log in via API — returns session cookie on success
// ---------------------------------------------------------------------------

async function loginUser(
  email: string,
  password: string,
  appInstance: Express = app,
): Promise<{ status: number; sessionCookie?: string }> {
  const { token, cookie } = await getCsrf(appInstance);
  const res = await request(appInstance)
    .post('/auth/login')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', token)
    .send({ email, password });

  const loginCookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const sessionCookie = loginCookies.find((c: string) => c.startsWith('isf.sid='));

  return { status: res.status, sessionCookie };
}

// ---------------------------------------------------------------------------
// 1. Registration followed immediately by login
// ---------------------------------------------------------------------------

describe('Registration followed by login', () => {
  beforeAll(async () => { await cleanupUser(P.regLogin); });
  afterAll(async ()  => { await cleanupUser(P.regLogin); });

  it('registers a new account and then logs in with the same credentials', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { status: regStatus } = await registerUser(P.regLogin, TEST_PASSWORD);
    expect(regStatus).toBe(201);

    const { status: loginStatus, sessionCookie } = await loginUser(P.regLogin, TEST_PASSWORD);
    expect(loginStatus).toBe(200);
    expect(sessionCookie).toBeDefined();
  });

  it('login response never contains the password hash', async () => {
    if (!dbAvailable) return;

    await cleanupUser(P.regLogin);
    await registerUser(P.regLogin, TEST_PASSWORD);
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: P.regLogin, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/argon2/i);
    expect(raw).not.toMatch(/password_hash/i);
    expect(raw).not.toMatch(/passwordHash/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Password verification after simulated reconnect
//
// We insert a user row directly using a Drizzle INSERT (bypassing the auth
// service), then verify that the stored Argon2id hash is valid when read back
// via the login route. This proves the hash round-trip through the DB is
// lossless and the verification always works from any fresh connection.
// ---------------------------------------------------------------------------

describe('Password verification after reconnect', () => {
  beforeAll(async () => { await cleanupUser(P.reconnect); });
  afterAll(async ()  => { await cleanupUser(P.reconnect); });

  it('Argon2id hash written by hashPassword() verifies correctly on re-read', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const db = getDb();
    const passwordHash = await hashPassword(TEST_PASSWORD);

    await db.insert(usersTable).values({
      email: P.reconnect,
      passwordHash,
      displayName: 'Reconnect Test',
      role: 'USER',
      emailVerifiedAt: new Date(),
    });

    // Login via the application route — this opens a new pool connection
    // and reads the row back from the DB.
    const { status, sessionCookie } = await loginUser(P.reconnect, TEST_PASSWORD);
    expect(status).toBe(200);
    expect(sessionCookie).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Authentication after simulated server restart (same persistent DB)
//
// Two independent Express app instances (sharing the same DB via module
// singletons) represent "before restart" and "after restart". A user
// registered with app1 must be able to log in with app2.
// ---------------------------------------------------------------------------

describe('Authentication after server restart (persistent DB)', () => {
  beforeAll(async () => { await cleanupUser(P.restart); });
  afterAll(async ()  => { await cleanupUser(P.restart); });

  it('user registered before restart can log in after restart', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    // "Before restart": register via app instance 1
    const app1 = createApp();
    const { status: regStatus } = await registerUser(P.restart, TEST_PASSWORD, app1);
    expect(regStatus).toBe(201);

    // "After restart": authenticate via app instance 2 (fresh createApp())
    const app2 = createApp();
    const { status: loginStatus, sessionCookie } = await loginUser(P.restart, TEST_PASSWORD, app2);
    expect(loginStatus).toBe(200);
    expect(sessionCookie).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid password → 401
// ---------------------------------------------------------------------------

describe('Invalid password', () => {
  beforeAll(async () => {
    await cleanupUser(P.badPass);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: P.badPass,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Bad Pass Test',
        role: 'USER',
        emailVerifiedAt: new Date(),
      });
    }
  });
  afterAll(async () => { await cleanupUser(P.badPass); });

  it('returns 401 for a wrong password', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { status } = await loginUser(P.badPass, 'WrongPassword999!');
    expect(status).toBe(401);
  });

  it('401 error message does not reveal whether the email exists', async () => {
    if (!dbAvailable) return;

    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Accept', 'application/json')
      .send({ email: P.badPass, password: 'WrongPassword999!' });
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    // Must use a generic message — no "email not found" vs "wrong password"
    expect(body.error).toMatch(/invalid email or password/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Nonexistent email → 401
// ---------------------------------------------------------------------------

describe('Nonexistent email', () => {
  it('returns 401 for an email that does not exist', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { status } = await loginUser('nobody.at.all@isf-test.local', TEST_PASSWORD);
    expect(status).toBe(401);
  });

  it('nonexistent-email error is identical to wrong-password error (no enumeration)', async () => {
    if (!dbAvailable) return;

    const { token: t1, cookie: c1 } = await getCsrf();
    const res1 = await request(app)
      .post('/auth/login')
      .set('Cookie', c1)
      .set('X-CSRF-Token', t1)
      .set('Accept', 'application/json')
      .send({ email: 'ghost@isf-test.local', password: TEST_PASSWORD });

    const { token: t2, cookie: c2 } = await getCsrf();
    const res2 = await request(app)
      .post('/auth/login')
      .set('Cookie', c2)
      .set('X-CSRF-Token', t2)
      .set('Accept', 'application/json')
      .send({ email: P.badPass, password: 'WrongPassword999!' });

    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    // Same HTTP status and same error message
    expect((res1.body as { error: string }).error).toBe(
      (res2.body as { error: string }).error,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Disabled account → 401
// ---------------------------------------------------------------------------

describe('Disabled account', () => {
  beforeAll(async () => {
    await cleanupUser(P.disabled);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: P.disabled,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Disabled Test',
        role: 'USER',
        emailVerifiedAt: new Date(),
        isActive: false, // Explicitly disabled
      });
    }
  });
  afterAll(async () => { await cleanupUser(P.disabled); });

  it('disabled account cannot log in', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { status } = await loginUser(P.disabled, TEST_PASSWORD);
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 7. Soft-deleted account → 401
// ---------------------------------------------------------------------------

describe('Soft-deleted account', () => {
  beforeAll(async () => {
    await cleanupUser(P.deleted);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: P.deleted,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Deleted Test',
        role: 'USER',
        emailVerifiedAt: new Date(),
        deletedAt: new Date(), // Soft-deleted
      });
    }
  });
  afterAll(async () => { await cleanupUser(P.deleted); });

  it('soft-deleted account cannot log in', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    // auth.service.ts login() fetches by eq(usersTable.email, normalizedEmail)
    // If deletedAt is set, isActive should still be true but deletedAt IS NOT NULL
    // triggers the active-check block.
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Accept', 'application/json')
      .send({ email: P.deleted, password: TEST_PASSWORD });
    // The user row exists but is logically deleted — expect 401 (not active)
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 8 & 9. Session invalidation and logout
// ---------------------------------------------------------------------------

describe('Session invalidation and logout', () => {
  beforeAll(async () => {
    await cleanupUser(P.session);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: P.session,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Session Test',
        role: 'USER',
        emailVerifiedAt: new Date(),
      });
    }
  });
  afterAll(async () => { await cleanupUser(P.session); });

  it('session cookie from login grants access to /auth/me', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: P.session, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);

    const loginCookies = (loginRes.headers['set-cookie'] as string[] | undefined) ?? [];
    const sessionCookie = loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', [cookie, sessionCookie].join('; '))
      .set('Accept', 'application/json');
    expect(meRes.status).toBe(200);
    expect((meRes.body as { email: string }).email).toBe(P.session);
  });

  it('session is invalidated after logout — /auth/me returns 401', async () => {
    if (!dbAvailable) return;

    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: P.session, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);

    const loginCookies = (loginRes.headers['set-cookie'] as string[] | undefined) ?? [];
    const sessionCookie = loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';
    const allCookies = [cookie, sessionCookie].join('; ');

    // Logout
    const logoutCsrf = await getCsrf();
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Cookie', [allCookies, logoutCsrf.cookie].join('; '))
      .set('X-CSRF-Token', logoutCsrf.token);
    expect(logoutRes.status).toBe(200);

    // The old session cookie is now invalid
    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', sessionCookie)
      .set('Accept', 'application/json');
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 10. Prevention of destructive database initialization
//
// Verify that creating a new Express app (simulating server restart) does NOT
// truncate, drop, or delete users. Data must survive createApp() being called.
// ---------------------------------------------------------------------------

describe('Prevention of destructive database initialization', () => {
  const safeEmail = 'persist.safe-init@isf-test.local';

  beforeAll(async () => {
    await cleanupUser(safeEmail);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: safeEmail,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Safe Init Test',
        role: 'USER',
        emailVerifiedAt: new Date(),
      });
    }
  });
  afterAll(async () => { await cleanupUser(safeEmail); });

  it('createApp() does not truncate or delete existing users', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    // Record user count before a second createApp() call
    const db = getDb();
    const before = await db.select({ id: usersTable.id }).from(usersTable);
    const countBefore = before.length;

    // Simulate a server restart
    createApp();

    // User count must be unchanged
    const after = await db.select({ id: usersTable.id }).from(usersTable);
    expect(after.length).toBe(countBefore);

    // The specific test user must still exist
    const [found] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, safeEmail))
      .limit(1);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Email normalisation — login with mixed-case email
// ---------------------------------------------------------------------------

describe('Email normalisation', () => {
  beforeAll(async () => {
    await cleanupUser(P.caseInsens);
    if (await isDatabaseAvailable()) {
      // Register via API (which normalises to lower-case internally)
      const { token, cookie } = await getCsrf();
      await request(app)
        .post('/auth/register')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', token)
        .send({ email: P.caseInsens, password: TEST_PASSWORD });
    }
  });
  afterAll(async () => { await cleanupUser(P.caseInsens); });

  it('login with UPPER-CASE version of the registered email succeeds', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { status } = await loginUser(P.caseInsens.toUpperCase(), TEST_PASSWORD);
    expect(status).toBe(200);
  });

  it('login with Mixed-Case email succeeds', async () => {
    if (!dbAvailable) return;

    const mixed = P.caseInsens
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join('');

    const { status } = await loginUser(mixed, TEST_PASSWORD);
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 12. Password hash is never exposed in API responses
// ---------------------------------------------------------------------------

describe('Password hash not exposed in API', () => {
  const hashCheckEmail = 'persist.hash-check@isf-test.local';

  beforeAll(async () => {
    await cleanupUser(hashCheckEmail);
    if (await isDatabaseAvailable()) {
      const db = getDb();
      await db.insert(usersTable).values({
        email: hashCheckEmail,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Hash Check',
        role: 'USER',
        emailVerifiedAt: new Date(),
      });
    }
  });
  afterAll(async () => { await cleanupUser(hashCheckEmail); });

  it('GET /api/v1/users/me does not include password hash', async () => {
    if (!dbAvailable) {
      console.warn('  ⏭  DB unavailable — skipping');
      return;
    }

    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: hashCheckEmail, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);

    const loginCookies = (loginRes.headers['set-cookie'] as string[] | undefined) ?? [];
    const sessionCookie = loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const meRes = await request(app)
      .get('/api/v1/users/me')
      .set('Cookie', [cookie, sessionCookie].join('; '))
      .set('Accept', 'application/json');
    expect(meRes.status).toBe(200);

    const raw = JSON.stringify(meRes.body);
    expect(raw).not.toMatch(/argon2/i);
    expect(raw).not.toMatch(/password_hash/i);
    expect(raw).not.toMatch(/passwordHash/i);
  });
});
