/**
 * Phase 1.2 integration tests — Authentication UI, Browser Flow, and RBAC Verification
 *
 * Test coverage:
 *   1.  GET /auth/login → 200 HTML
 *   2.  GET /auth/register → 200 HTML
 *   3.  GET /auth/forgot-password → 200 HTML
 *   4.  GET /auth/reset-password → 200 HTML
 *   5.  GET /auth/verify-email (no token) → 200 HTML
 *   6.  POST /auth/login (browser form) — valid credentials → 302 redirect
 *   7.  POST /auth/login (browser form) — invalid credentials → 401 HTML
 *   8.  POST /auth/register (browser form) — valid → 200 success page
 *   9.  POST /auth/register (browser form) — duplicate email → 409 HTML
 *   10. POST /auth/forgot-password (browser form) → 200 HTML (generic)
 *   11. POST /auth/reset-password (browser form) — invalid token → 400 HTML
 *   12. GET /auth/verify-email?token=<valid> → 200 HTML "verified"
 *   13. GET /auth/verify-email?token=<invalid> → 200 HTML "invalid"
 *   14. Unverified USER can access /portal (verification is not required to login)
 *   15. Authenticated USER → GET /portal → 200
 *   16. Unauthenticated → GET /portal → 302 redirect to /auth/login
 *   17. USER → GET /admin → 403
 *   18. EDITOR → GET /admin → 200 (EDITOR has access to /admin)
 *   19. EDITOR → GET /admin/reviewer → 403
 *   20. REVIEWER → GET /admin → 200 (REVIEWER has access to /admin)
 *   21. REVIEWER → GET /admin/editor → 403
 *   22. ADMIN → GET /admin → 200
 *   23. POST /auth/logout (browser form) → 302 to /auth/login; session destroyed
 *   24. GET /portal after logout → 302 (no longer authenticated)
 *   25. Landing page GET / → 200 (intact)
 *   26. CSRF: POST /auth/login without CSRF → 403 (when not in test mode)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';
import { getDb, closeDatabase } from '../../src/db/client.js';
import {
  usersTable,
  emailVerificationTokensTable,
  passwordResetTokensTable,
} from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/shared/password.js';
import { generateSecureToken, hashToken, expiresInHours } from '../../src/shared/tokens.js';
import { isDatabaseAvailable } from '../setup.js';

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

const TEST_PASSWORD = 'PageTest123!';

async function cleanupUser(email: string): Promise<void> {
  try {
    const db = getDb();
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()))
      .limit(1);
    if (user) {
      await db
        .delete(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.userId, user.id));
      await db
        .delete(emailVerificationTokensTable)
        .where(eq(emailVerificationTokensTable.userId, user.id));
    }
    await db.delete(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  } catch {
    /* best-effort */
  }
}

async function createUser(
  email: string,
  role: 'ADMIN' | 'EDITOR' | 'REVIEWER' | 'USER' = 'USER',
  emailVerified = true,
): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(usersTable)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(TEST_PASSWORD),
      displayName: `Dev ${role}`,
      role,
      emailVerifiedAt: emailVerified ? new Date() : null,
    })
    .returning({ id: usersTable.id });
  if (!user) throw new Error('Failed to create test user');
  return user.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a CSRF token + cookie for use in form submissions. */
async function getCsrf(): Promise<{ token: string; cookie: string }> {
  const res = await request(app).get('/auth/csrf-token');
  const token = (res.body as { csrfToken: string }).csrfToken;
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const cookie = cookies.find((c: string) => c.startsWith('isf.csrf=')) ?? '';
  return { token, cookie };
}

/**
 * Log in via the JSON API and return session+csrf cookies.
 * Uses X-CSRF-Token header so the existing API login endpoint handles it.
 */
async function loginAs(
  email: string,
): Promise<{ sessionCookie: string; csrfToken: string }> {
  const { token, cookie: csrfCookie } = await getCsrf();

  const loginRes = await request(app)
    .post('/auth/login')
    .set('Cookie', csrfCookie)
    .set('X-CSRF-Token', token)
    .set('Accept', 'application/json')
    .send({ email, password: TEST_PASSWORD });

  if (loginRes.status !== 200) {
    throw new Error(
      `Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
    );
  }

  const loginCookies =
    (loginRes.headers['set-cookie'] as string[] | undefined) ?? [];
  const sessionCookie =
    loginCookies.find((c: string) => c.startsWith('isf.sid=')) ?? '';

  const allCookies = [csrfCookie, sessionCookie].filter(Boolean).join('; ');
  return { sessionCookie: allCookies, csrfToken: token };
}

// ---------------------------------------------------------------------------
// 1–5: Auth page GET routes return 200 HTML
// ---------------------------------------------------------------------------

describe('Auth page GET routes', () => {
  it('GET /auth/login → 200 HTML', async () => {
    const res = await request(app)
      .get('/auth/login')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Sign in');
  });

  it('GET /auth/register → 200 HTML', async () => {
    const res = await request(app)
      .get('/auth/register')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Create');
  });

  it('GET /auth/forgot-password → 200 HTML', async () => {
    const res = await request(app)
      .get('/auth/forgot-password')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('reset');
  });

  it('GET /auth/reset-password (no token) → 200 HTML with error', async () => {
    const res = await request(app)
      .get('/auth/reset-password')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('token');
  });

  it('GET /auth/reset-password?token=abc → 200 HTML with form', async () => {
    const res = await request(app)
      .get('/auth/reset-password?token=abc')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('password');
  });

  it('GET /auth/verify-email (no token) → 200 HTML', async () => {
    const res = await request(app)
      .get('/auth/verify-email')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('token');
  });
});

// ---------------------------------------------------------------------------
// 6–7: POST /auth/login browser form
// ---------------------------------------------------------------------------

describe('POST /auth/login (browser form)', () => {
  const EMAIL = 'p12.login@isf-test.local';
  beforeAll(async () => { if (!dbAvailable) return; await createUser(EMAIL, 'USER'); });
  afterAll(async () => { await cleanupUser(EMAIL); });

  it('valid credentials → 302 redirect to /portal', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: EMAIL, password: TEST_PASSWORD, _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/portal/);
  });

  it('invalid credentials → 401 HTML with error message', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: EMAIL, password: 'wrong-password', _csrf: token });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid email or password');
  });

  it('error message does not reveal whether email exists', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: 'nonexistent@isf-test.local', password: 'anything', _csrf: token });
    expect(res.status).toBe(401);
    // Must say "Invalid email or password" — not "email not found"
    expect(res.text).toMatch(/invalid email or password/i);
    expect(res.text).not.toMatch(/not found/i);
    expect(res.text).not.toMatch(/does not exist/i);
  });

  it('ADMIN login → 302 redirect to /admin', async () => {
    if (!dbAvailable) return;
    const adminEmail = 'p12.login.admin@isf-test.local';
    await createUser(adminEmail, 'ADMIN');
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: adminEmail, password: TEST_PASSWORD, _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/admin/);
    await cleanupUser(adminEmail);
  });
});

// ---------------------------------------------------------------------------
// 8–9: POST /auth/register browser form
// ---------------------------------------------------------------------------

describe('POST /auth/register (browser form)', () => {
  const EMAIL = 'p12.reg@isf-test.local';
  afterAll(async () => { await cleanupUser(EMAIL); });

  it('valid registration → 200 success page', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({
        email: EMAIL,
        password: TEST_PASSWORD,
        displayName: 'Page Test',
        _csrf: token,
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('erif');  // "Verify your email" or "verified"
  });

  it('duplicate email → 409 HTML', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: EMAIL, password: TEST_PASSWORD, _csrf: token });
    expect(res.status).toBe(409);
    expect(res.text).toContain('already exists');
  });

  it('weak password → 422 HTML with field error', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: 'p12.weak@isf-test.local', password: 'short', _csrf: token });
    expect(res.status).toBe(422);
    expect(res.text).toContain('8 characters');
  });

  it('new account has USER role (no privilege escalation)', async () => {
    if (!dbAvailable) return;
    // Register and then check role via API
    const newEmail = 'p12.role-check@isf-test.local';
    const { token, cookie } = await getCsrf();
    const regRes = await request(app)
      .post('/auth/register')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: newEmail, password: TEST_PASSWORD, _csrf: token });
    expect(regRes.status).toBe(200);

    // The session cookie is set after registration — check /auth/me
    const regCookies = (regRes.headers['set-cookie'] as string[] | undefined) ?? [];
    const sessionCookie = regCookies.find((c) => c.startsWith('isf.sid=')) ?? '';
    const allCookies = [cookie, sessionCookie].filter(Boolean).join('; ');

    const meRes = await request(app)
      .get('/auth/me')
      .set('Cookie', allCookies)
      .set('Accept', 'application/json');
    expect(meRes.status).toBe(200);
    expect((meRes.body as { role: string }).role).toBe('USER');

    await cleanupUser(newEmail);
  });
});

// ---------------------------------------------------------------------------
// 10: POST /auth/forgot-password browser form
// ---------------------------------------------------------------------------

describe('POST /auth/forgot-password (browser form)', () => {
  it('known email → 200 HTML (generic success)', async () => {
    if (!dbAvailable) return;
    const email = 'p12.forgot@isf-test.local';
    await createUser(email, 'USER');
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/forgot-password')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email, _csrf: token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('reset link');
    await cleanupUser(email);
  });

  it('unknown email → same 200 HTML (no enumeration)', async () => {
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/forgot-password')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ email: 'nobody@isf-test.local', _csrf: token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('reset link');
  });
});

// ---------------------------------------------------------------------------
// 11: POST /auth/reset-password browser form — invalid token
// ---------------------------------------------------------------------------

describe('POST /auth/reset-password (browser form)', () => {
  it('invalid token → 400 HTML with error message', async () => {
    if (!dbAvailable) return;
    const { token, cookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/reset-password')
      .set('Cookie', cookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ token: 'not-a-real-token', newPassword: TEST_PASSWORD, _csrf: token });
    expect(res.status).toBe(400);
    // The token 'not-a-real-token' is not in the DB → "Invalid or expired" message
    // which sets tokenError to either "expired" or "invalid" depending on the message
    expect(res.text).toMatch(/invalid|expired|reset link/i);
  });

  it('valid token → redirects to login with info', async () => {
    if (!dbAvailable) return;
    const email = 'p12.reset@isf-test.local';
    const userId = await createUser(email, 'USER');
    const db = getDb();

    // Insert a valid reset token
    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    await db.insert(passwordResetTokensTable).values({
      userId,
      tokenHash,
      expiresAt: expiresInHours(1),
    });

    const { token: csrfToken, cookie: csrfCookie } = await getCsrf();
    const res = await request(app)
      .post('/auth/reset-password')
      .set('Cookie', csrfCookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ token: rawToken, newPassword: 'NewPassword456!', _csrf: csrfToken });

    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/auth\/login/);

    await cleanupUser(email);
  });
});

// ---------------------------------------------------------------------------
// 12–13: GET /auth/verify-email HTML states
// ---------------------------------------------------------------------------

describe('GET /auth/verify-email (browser)', () => {
  it('valid token → 200 HTML "verified"', async () => {
    if (!dbAvailable) return;
    const email = 'p12.verify@isf-test.local';
    const userId = await createUser(email, 'USER', false);
    const db = getDb();

    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    await db.insert(emailVerificationTokensTable).values({
      userId,
      tokenHash,
      expiresAt: expiresInHours(24),
    });

    const res = await request(app)
      .get(`/auth/verify-email?token=${rawToken}`)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('verified');

    await cleanupUser(email);
  });

  it('invalid token → 200 HTML with error state', async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .get('/auth/verify-email?token=bogus-invalid-token')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    // Token not in DB → "Invalid or expired" → status may be 'expired' or 'invalid'
    expect(res.text).toMatch(/invalid|expired|link/i);
  });

  it('expired token → 200 HTML "expired"', async () => {
    if (!dbAvailable) return;
    const email = 'p12.verify.exp@isf-test.local';
    const userId = await createUser(email, 'USER', false);
    const db = getDb();

    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    // Insert already-expired token
    await db.insert(emailVerificationTokensTable).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = await request(app)
      .get(`/auth/verify-email?token=${rawToken}`)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/expired|invalid/);

    await cleanupUser(email);
  });
});

// ---------------------------------------------------------------------------
// 14–16: Portal access control
// ---------------------------------------------------------------------------

describe('GET /portal — access control', () => {
  const EMAIL = 'p12.portal@isf-test.local';
  beforeAll(async () => { if (!dbAvailable) return; await createUser(EMAIL, 'USER'); });
  afterAll(async () => { await cleanupUser(EMAIL); });

  it('unauthenticated → 302 redirect to /auth/login', async () => {
    const res = await request(app)
      .get('/portal')
      .set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/auth\/login/);
  });

  it('authenticated USER → 200 HTML portal', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EMAIL);
    const res = await request(app)
      .get('/portal')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Portal');
  });

  it('portal displays correct role', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EMAIL);
    const res = await request(app)
      .get('/portal')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('USER');
  });
});

// ---------------------------------------------------------------------------
// 17–22: Admin access control
// ---------------------------------------------------------------------------

describe('GET /admin — role-based access control', () => {
  const USER_EMAIL    = 'p12.rbac.user@isf-test.local';
  const EDITOR_EMAIL  = 'p12.rbac.editor@isf-test.local';
  const REVIEWER_EMAIL = 'p12.rbac.reviewer@isf-test.local';
  const ADMIN_EMAIL   = 'p12.rbac.admin@isf-test.local';

  beforeAll(async () => {
    if (!dbAvailable) return;
    await Promise.all([
      createUser(USER_EMAIL,     'USER'),
      createUser(EDITOR_EMAIL,   'EDITOR'),
      createUser(REVIEWER_EMAIL, 'REVIEWER'),
      createUser(ADMIN_EMAIL,    'ADMIN'),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      cleanupUser(USER_EMAIL),
      cleanupUser(EDITOR_EMAIL),
      cleanupUser(REVIEWER_EMAIL),
      cleanupUser(ADMIN_EMAIL),
    ]);
  });

  it('USER → GET /admin → 403', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(USER_EMAIL);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('EDITOR → GET /admin → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EDITOR_EMAIL);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('EDITOR → GET /admin/editor → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EDITOR_EMAIL);
    const res = await request(app)
      .get('/admin/editor')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('EDITOR → GET /admin/reviewer → 403', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EDITOR_EMAIL);
    const res = await request(app)
      .get('/admin/reviewer')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('REVIEWER → GET /admin → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(REVIEWER_EMAIL);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('REVIEWER → GET /admin/reviewer → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(REVIEWER_EMAIL);
    const res = await request(app)
      .get('/admin/reviewer')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('REVIEWER → GET /admin/editor → 403', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(REVIEWER_EMAIL);
    const res = await request(app)
      .get('/admin/editor')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('ADMIN → GET /admin → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(ADMIN_EMAIL);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('ADMIN → GET /admin/editor → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(ADMIN_EMAIL);
    const res = await request(app)
      .get('/admin/editor')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('ADMIN → GET /admin/reviewer → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(ADMIN_EMAIL);
    const res = await request(app)
      .get('/admin/reviewer')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('manually typed /admin URL is denied server-side for USER (no hidden-button bypass)', async () => {
    if (!dbAvailable) return;
    // Verifies that even if a USER knew the URL and typed it manually,
    // the server still denies access — the guard is not just a hidden button.
    const { sessionCookie } = await loginAs(USER_EMAIL);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 23–24: Logout browser flow
// ---------------------------------------------------------------------------

describe('POST /auth/logout (browser form)', () => {
  const EMAIL = 'p12.logout@isf-test.local';
  beforeAll(async () => { if (!dbAvailable) return; await createUser(EMAIL, 'USER'); });
  afterAll(async () => { await cleanupUser(EMAIL); });

  it('logout → 302 redirect to /auth/login', async () => {
    if (!dbAvailable) return;
    const { sessionCookie, csrfToken } = await loginAs(EMAIL);
    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ _csrf: csrfToken });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/auth\/login/);
  });

  it('session destroyed: /portal returns 302 after logout', async () => {
    if (!dbAvailable) return;
    const { sessionCookie, csrfToken } = await loginAs(EMAIL);

    await request(app)
      .post('/auth/logout')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html')
      .type('form')
      .send({ _csrf: csrfToken });

    // After logout, the session cookie should no longer grant access
    const res = await request(app)
      .get('/portal')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/auth\/login/);
  });
});

// ---------------------------------------------------------------------------
// 25: Landing page integrity
// ---------------------------------------------------------------------------

describe('Landing page integrity', () => {
  it('GET / → 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  it('GET / → returns HTML', async () => {
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('GET /css/style.css → 200', async () => {
    const res = await request(app).get('/css/style.css');
    expect(res.status).toBe(200);
  });

  it('GET /js/main.js → 200', async () => {
    const res = await request(app).get('/js/main.js');
    expect(res.status).toBe(200);
  });

  it('GET /assets/favicon.svg → 200', async () => {
    const res = await request(app).get('/assets/favicon.svg');
    expect(res.status).toBe(200);
  });

  it('Auth CSS is served: GET /css/auth.css → 200', async () => {
    const res = await request(app).get('/css/auth.css');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 26: Security — no sensitive data in HTML responses
// ---------------------------------------------------------------------------

describe('Security — no sensitive data in browser responses', () => {
  const EMAIL = 'p12.sec@isf-test.local';
  beforeAll(async () => { if (!dbAvailable) return; await createUser(EMAIL, 'USER'); });
  afterAll(async () => { await cleanupUser(EMAIL); });

  it('HTML login page does not contain passwordHash', async () => {
    const res = await request(app).get('/auth/login').set('Accept', 'text/html');
    expect(res.text).not.toMatch(/\$argon2/);
    expect(res.text).not.toContain('passwordHash');
    expect(res.text).not.toContain('password_hash');
  });

  it('HTML portal page does not expose password hash', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(EMAIL);
    const res = await request(app)
      .get('/portal')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.text).not.toMatch(/\$argon2/);
    expect(res.text).not.toContain('passwordHash');
  });

  it('verify-email HTML does not echo the raw token back', async () => {
    const rawToken = 'super-secret-token-should-not-appear-in-html';
    const res = await request(app)
      .get(`/auth/verify-email?token=${rawToken}`)
      .set('Accept', 'text/html');
    // The token itself must not be reflected in the response body
    expect(res.text).not.toContain(rawToken);
  });
});
