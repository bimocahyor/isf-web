/**
 * Phase 1 integration tests — Authentication, Sessions, RBAC
 *
 * Test coverage:
 *   1. POST /auth/register — happy path, validation errors, duplicate email
 *   2. POST /auth/login    — happy path, wrong password, unknown email
 *   3. POST /auth/logout   — authenticated, unauthenticated
 *   4. GET  /auth/me       — authenticated, unauthenticated
 *   5. GET  /api/v1/users/me — full profile, unauthenticated
 *   6. RBAC middleware     — requireAuth, requirePermission
 *   7. Session persistence — cookie carries session across requests
 *
 * Note: All state-changing requests now require a CSRF token.
 * Use the withCsrf() helper below to attach the token.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';
import { getDb, closeDatabase } from '../../src/db/client.js';
import { usersTable } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/shared/password.js';
import { isDatabaseAvailable } from '../setup.js';

// ---------------------------------------------------------------------------
// Typed response body helpers
// ---------------------------------------------------------------------------

interface AuthUserBody {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface AuthSuccessBody {
  message: string;
  user: AuthUserBody;
}

interface ValidationErrorBody {
  error: string;
  details: Array<{ field: string; message: string }>;
}

interface ErrorBody {
  error: string;
}

interface MeBody {
  id: string;
  email: string;
  role: string;
}

interface UserProfileBody {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerifiedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: Express;
let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  app = createApp();
});

afterAll(async () => {
  await closeDatabase();
});

// Test user credentials
const TEST_EMAIL = 'test.phase1@isf-test.local';
const TEST_PASSWORD = 'TestPassword123!';
const TEST_DISPLAY = 'Phase1 Tester';

async function cleanupTestUser(email: string): Promise<void> {
  try {
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// CSRF helper — fetches a fresh token+cookie pair
// ---------------------------------------------------------------------------

interface CsrfPair {
  token: string;
  cookie: string;
}

async function getCsrf(): Promise<CsrfPair> {
  const res = await request(app).get('/auth/csrf-token');
  const token = (res.body as { csrfToken: string }).csrfToken;
  const cookies = res.headers['set-cookie'] as string[] | undefined ?? [];
  const cookie = cookies.find((c: string) => c.startsWith('isf.csrf=')) ?? '';
  return { token, cookie };
}

// ---------------------------------------------------------------------------
// 1. POST /auth/register
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  beforeAll(async () => {
    // Ensure leftover emails from previous failed runs are cleaned up
    await cleanupTestUser(TEST_EMAIL);
    await cleanupTestUser('test.reg.cookie@isf-test.local');
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
    await cleanupTestUser('test.reg.cookie@isf-test.local');
  });

  it('creates a new account and returns 201 with user data', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        displayName: TEST_DISPLAY,
      });

    expect(res.status).toBe(201);
    const body = res.body as AuthSuccessBody;
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body.user.displayName).toBe(TEST_DISPLAY);
    expect(body.user.role).toBe('USER');
    expect(body.user.id).toBeDefined();
    expect(typeof body.user.id).toBe('string');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
  });

  it('sets a session cookie on successful registration', async () => {
    if (!dbAvailable) return;
    const email2 = 'test.reg.cookie@isf-test.local';
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: email2, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    const cookies = res.headers['set-cookie'] as string[] | undefined;
    expect(cookies).toBeDefined();
    expect(
      (cookies ?? []).some((c: string) => c.startsWith('isf.sid=')),
    ).toBe(true);
    await cleanupTestUser(email2);
  });

  it('returns 409 Conflict when email already exists', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Accept', 'application/json')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBeDefined();
  });

  it('returns 422 with validation details for invalid email', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: 'not-an-email', password: TEST_PASSWORD });
    expect(res.status).toBe(422);
    const body = res.body as ValidationErrorBody;
    expect(body.error).toBe('Validation failed');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns 422 for password shorter than 8 characters', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: 'short@example.com', password: 'abc' });
    expect(res.status).toBe(422);
  });

  it('returns 422 when email is missing', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, TEST_EMAIL));
    await db.insert(usersTable).values({
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: TEST_DISPLAY,
      role: 'USER',
    });
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
  });

  it('returns 200 with user data and sets session cookie', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    const body = res.body as AuthSuccessBody;
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body.user.role).toBe('USER');
    const cookies = res.headers['set-cookie'] as string[] | undefined;
    expect(cookies).toBeDefined();
    expect(
      (cookies ?? []).some((c: string) => c.startsWith('isf.sid=')),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('returns 401 for wrong password', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .set('Accept', 'application/json')
      .send({ email: TEST_EMAIL, password: 'WrongPassword!' });
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error).toBeDefined();
  });

  it('returns 401 for unknown email', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('returns 422 for missing password', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// 3. POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, TEST_EMAIL));
    await db.insert(usersTable).values({
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: TEST_DISPLAY,
      role: 'USER',
    });
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
  });

  it('returns 200 and a message on successful logout', async () => {
    if (!dbAvailable) return;
    const loginCsrf = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', loginCsrf.cookie)
      .set('X-CSRF-Token', loginCsrf.token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(200);
    const loginCookies = loginRes.headers['set-cookie'] as string[];
    const sessionCookie =
      loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const logoutCsrf = await getCsrf();
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Cookie', [loginCsrf.cookie, sessionCookie, logoutCsrf.cookie].join('; '))
      .set('X-CSRF-Token', logoutCsrf.token);
    expect(logoutRes.status).toBe(200);
    expect((logoutRes.body as { message: string }).message).toBeDefined();
  });

  it('returns 401 when not authenticated', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, TEST_EMAIL));
    await db.insert(usersTable).values({
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: TEST_DISPLAY,
      role: 'USER',
    });
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
  });

  it('returns session user data when authenticated', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const loginCookies = loginRes.headers['set-cookie'] as string[];
    const sessionCookie =
      loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', [cookie, sessionCookie].join('; '));
    expect(meRes.status).toBe(200);
    const body = meRes.body as MeBody;
    expect(body.email).toBe(TEST_EMAIL);
    expect(body.role).toBe('USER');
    expect(body.id).toBeDefined();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /api/v1/users/me
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/me', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, TEST_EMAIL));
    await db.insert(usersTable).values({
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: TEST_DISPLAY,
      role: 'USER',
    });
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
  });

  it('returns full user profile from DB when authenticated', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const loginCookies = loginRes.headers['set-cookie'] as string[];
    const sessionCookie =
      loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Cookie', [cookie, sessionCookie].join('; '));
    expect(res.status).toBe(200);
    const body = res.body as UserProfileBody;
    expect(body.email).toBe(TEST_EMAIL);
    expect(body.displayName).toBe(TEST_DISPLAY);
    expect(body.role).toBe('USER');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 6. RBAC — permission checks (unit-style, no HTTP)
// ---------------------------------------------------------------------------

describe('RBAC — hasPermission', async () => {
  const { hasPermission } = await import('../../src/shared/rbac.js');

  it('ADMIN has elevated permissions (article:publish, finance:reverse, user:delete)', () => {
    expect(hasPermission('ADMIN', 'article:publish')).toBe(true);
    expect(hasPermission('ADMIN', 'finance:reverse')).toBe(true);
    expect(hasPermission('ADMIN', 'user:delete')).toBe(true);
  });

  it('USER has only their own permissions', () => {
    expect(hasPermission('USER', 'application:create')).toBe(true);
    expect(hasPermission('USER', 'profile:edit')).toBe(true);
    expect(hasPermission('USER', 'article:publish')).toBe(false);
    expect(hasPermission('USER', 'finance:post')).toBe(false);
    expect(hasPermission('USER', 'user:delete')).toBe(false);
  });

  it('EDITOR has content and finance-draft permissions', () => {
    expect(hasPermission('EDITOR', 'article:create')).toBe(true);
    expect(hasPermission('EDITOR', 'finance:view')).toBe(true);
    expect(hasPermission('EDITOR', 'finance:create_draft')).toBe(true);
    expect(hasPermission('EDITOR', 'finance:approve')).toBe(false);
    expect(hasPermission('EDITOR', 'finance:post')).toBe(false);
    expect(hasPermission('EDITOR', 'finance:reverse')).toBe(false);
    expect(hasPermission('EDITOR', 'application:review')).toBe(false);
  });

  it('REVIEWER has review permissions but not financial posting', () => {
    expect(hasPermission('REVIEWER', 'application:review')).toBe(true);
    expect(hasPermission('REVIEWER', 'article:approve')).toBe(true);
    expect(hasPermission('REVIEWER', 'finance:post')).toBe(false);
    expect(hasPermission('REVIEWER', 'user:delete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Session persistence across requests
// ---------------------------------------------------------------------------

describe('Session persistence', () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    const db = getDb();
    await db.delete(usersTable).where(eq(usersTable.email, TEST_EMAIL));
    await db.insert(usersTable).values({
      email: TEST_EMAIL,
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: TEST_DISPLAY,
      role: 'USER',
    });
  });

  afterAll(async () => {
    await cleanupTestUser(TEST_EMAIL);
  });

  it('session cookie from login is accepted on subsequent requests', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const loginCookies = loginRes.headers['set-cookie'] as string[];
    const sessionCookie =
      loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';
    expect(sessionCookie).not.toBe('');

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', [cookie, sessionCookie].join('; '));
    expect(meRes.status).toBe(200);
    expect((meRes.body as MeBody).email).toBe(TEST_EMAIL);
  });

  it('session is invalidated after logout', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', token)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const loginCookies = loginRes.headers['set-cookie'] as string[];
    const sessionCookie =
      loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

    const logoutCsrf = await getCsrf();
    await request(app)
      .post('/auth/logout')
      .set('Cookie', [cookie, sessionCookie, logoutCsrf.cookie].join('; '))
      .set('X-CSRF-Token', logoutCsrf.token);

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', [cookie, sessionCookie].join('; '));
    expect(meRes.status).toBe(401);
  });
});
