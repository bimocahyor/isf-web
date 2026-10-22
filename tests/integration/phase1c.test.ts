/**
 * Phase 1C integration tests — OWNER role, invitation flow, user management
 *
 * Test coverage:
 *   1.  GET /owner → 302 for unauthenticated
 *   2.  GET /owner → 403 for USER
 *   3.  GET /owner → 403 for ADMIN
 *   4.  GET /owner → 200 for OWNER
 *   5.  GET /owner/users → 200 for OWNER
 *   6.  GET /owner/users → 403 for ADMIN
 *   7.  GET /owner/invitations → 200 for OWNER
 *   8.  POST /owner/invite → redirect with OWNER session
 *   9.  POST /owner/invite → 403 for ADMIN
 *   10. GET /auth/accept-invitation?token=<invalid> → 200 HTML (invalid state)
 *   11. GET /auth/accept-invitation?token=<valid> → 200 HTML (form shown)
 *   12. POST /auth/accept-invitation → creates account and shows success
 *   13. POST /owner/invitations/:id/revoke → revokes invitation
 *   14. GET /owner/users/:id → 200 for OWNER
 *   15. POST /owner/users/:id/role → changes role
 *   16. POST /owner/users/:id/disable → disables account
 *   17. POST /owner/users/:id/reactivate → reactivates account
 *   18. Accepted invitation token cannot be reused
 *   19. OWNER can access /admin
 *   20. OWNER is redirected to /owner after login
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';
import { getDb, closeDatabase } from '../../src/db/client.js';
import {
  usersTable,
  invitationsTable,
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

const TEST_PASSWORD = 'Phase1cTest!';

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

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

async function cleanupInvitation(email: string): Promise<void> {
  try {
    const db = getDb();
    await db
      .delete(invitationsTable)
      .where(eq(invitationsTable.email, email.toLowerCase()));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Creation helpers
// ---------------------------------------------------------------------------

async function createUser(
  email: string,
  role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'REVIEWER' | 'USER' = 'USER',
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

async function createInvitationRecord(
  email: string,
  role: string,
  invitedByUserId: string,
): Promise<{ rawToken: string; invitationId: string }> {
  const db = getDb();
  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);

  const [inv] = await db
    .insert(invitationsTable)
    .values({
      email: email.toLowerCase(),
      role,
      invitedBy: invitedByUserId,
      tokenHash,
      expiresAt: expiresInHours(72),
    })
    .returning({ id: invitationsTable.id });

  if (!inv) throw new Error('Failed to create invitation');
  return { rawToken, invitationId: inv.id };
}

// ---------------------------------------------------------------------------
// Login helper (via JSON API)
// ---------------------------------------------------------------------------

async function getCsrf(): Promise<{ token: string; cookie: string }> {
  const res = await request(app).get('/auth/csrf-token');
  const token = (res.body as { csrfToken: string }).csrfToken;
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const cookie = cookies.find((c: string) => c.startsWith('isf.csrf=')) ?? '';
  return { token, cookie };
}

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
      `Login failed for ${email}: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
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
// Test emails (unique per test file to avoid collisions)
// ---------------------------------------------------------------------------

const T = {
  owner:   'test.1c.owner@isf-test.local',
  admin:   'test.1c.admin@isf-test.local',
  user:    'test.1c.user@isf-test.local',
  invited: 'test.1c.invited@isf-test.local',
  target:  'test.1c.target@isf-test.local',
};

// ---------------------------------------------------------------------------
// 1. GET /owner — unauthenticated → redirect to login
// ---------------------------------------------------------------------------

describe('GET /owner — access control', () => {
  let ownerId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    await Promise.all(Object.values(T).map((e) => cleanupUser(e)));
    await cleanupInvitation(T.invited);

    ownerId = await createUser(T.owner, 'OWNER');
    await createUser(T.admin, 'ADMIN');
    await createUser(T.user,  'USER');
  });

  afterAll(async () => {
    await Promise.all(Object.values(T).map((e) => cleanupUser(e)));
    await cleanupInvitation(T.invited);
  });

  it('unauthenticated → 302 redirect to /auth/login', async () => {
    const res = await request(app).get('/owner').set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/auth\/login/);
  });

  it('USER → 403 Forbidden', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.user);
    const res = await request(app)
      .get('/owner')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('ADMIN → 403 Forbidden', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.admin);
    const res = await request(app)
      .get('/owner')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  it('OWNER → 200 OK with dashboard HTML', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.owner);
    const res = await request(app)
      .get('/owner')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Owner Dashboard');
  });

  // ── /owner/users ───────────────────────────────────────────────────────────

  it('GET /owner/users → 200 for OWNER', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.owner);
    const res = await request(app)
      .get('/owner/users')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('User');
  });

  it('GET /owner/users → 403 for ADMIN', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.admin);
    const res = await request(app)
      .get('/owner/users')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(403);
  });

  // ── /owner/invitations ─────────────────────────────────────────────────────

  it('GET /owner/invitations → 200 for OWNER', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.owner);
    const res = await request(app)
      .get('/owner/invitations')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invitation');
  });

  // ── OWNER can access /admin ────────────────────────────────────────────────

  it('OWNER → GET /admin → 200', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.owner);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  // ── POST /owner/invite ────────────────────────────────────────────────────

  it('POST /owner/invite → OWNER → redirects (invite created)', async () => {
    if (!dbAvailable) return;
    const { sessionCookie, csrfToken } = await loginAs(T.owner);
    const res = await request(app)
      .post('/owner/invite')
      .set('Cookie', sessionCookie)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`_csrf=${encodeURIComponent(csrfToken)}&email=${encodeURIComponent(T.invited)}&role=USER`);

    // Should redirect (success or error) — never a 5xx
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/owner\/invitations/);
  });

  it('POST /owner/invite → ADMIN → 403', async () => {
    if (!dbAvailable) return;
    const { sessionCookie, csrfToken } = await loginAs(T.admin);
    const res = await request(app)
      .post('/owner/invite')
      .set('Cookie', sessionCookie)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`_csrf=${encodeURIComponent(csrfToken)}&email=other@isf-test.local&role=USER`);

    expect(res.status).toBe(403);
  });

  // ── Accept invitation GET ──────────────────────────────────────────────────

  it('GET /auth/accept-invitation (no token) → 200 HTML invalid state', async () => {
    const res = await request(app)
      .get('/auth/accept-invitation')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invalid');
  });

  it('GET /auth/accept-invitation?token=badtoken → 200 HTML invalid state', async () => {
    const res = await request(app)
      .get('/auth/accept-invitation?token=notavalidtoken')
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/invalid|expired|Invalid/i);
  });

  it('GET /auth/accept-invitation?token=<valid> → 200 HTML form', async () => {
    if (!dbAvailable) return;
    const ownId = await (async () => {
      const db = getDb();
      const [r] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, T.owner))
        .limit(1);
      return r?.id ?? ownerId;
    })();

    const { rawToken } = await createInvitationRecord(
      'valid.inv@isf-test.local',
      'USER',
      ownId,
    );

    const res = await request(app)
      .get(`/auth/accept-invitation?token=${rawToken}`)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Set Up|Activate/i);

    // Cleanup
    await cleanupInvitation('valid.inv@isf-test.local');
    await cleanupUser('valid.inv@isf-test.local');
  });

  // ── Accept invitation POST ─────────────────────────────────────────────────

  it('POST /auth/accept-invitation → creates account from valid token', async () => {
    if (!dbAvailable) return;
    const ownId = ownerId;
    const invEmail = 'accept.inv.1c@isf-test.local';

    try {
      await cleanupUser(invEmail);
      await cleanupInvitation(invEmail);

      const { rawToken } = await createInvitationRecord(invEmail, 'EDITOR', ownId);

      const { token: csrfToken, cookie: csrfCookie } = await getCsrf();

      const res = await request(app)
        .post('/auth/accept-invitation')
        .set('Cookie', csrfCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(
          `_csrf=${encodeURIComponent(csrfToken)}` +
          `&token=${encodeURIComponent(rawToken)}` +
          `&password=${encodeURIComponent('NewPass123!')}` +
          `&confirmPassword=${encodeURIComponent('NewPass123!')}` +
          `&displayName=Test+Invitee`,
        );

      // Renders success page
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/Account Created|Welcome/i);

      // Verify user was created in DB
      const db = getDb();
      const [created] = await db
        .select({ role: usersTable.role, emailVerifiedAt: usersTable.emailVerifiedAt })
        .from(usersTable)
        .where(eq(usersTable.email, invEmail))
        .limit(1);

      expect(created).toBeDefined();
      expect(created?.role).toBe('EDITOR');
      expect(created?.emailVerifiedAt).not.toBeNull();
    } finally {
      await cleanupUser(invEmail);
      await cleanupInvitation(invEmail);
    }
  });

  it('POST /auth/accept-invitation — already accepted token → 400', async () => {
    if (!dbAvailable) return;
    const ownId = ownerId;
    const invEmail = 'accept.inv.used@isf-test.local';

    try {
      await cleanupUser(invEmail);
      await cleanupInvitation(invEmail);

      const { rawToken } = await createInvitationRecord(invEmail, 'USER', ownId);
      const { token: csrfToken, cookie: csrfCookie } = await getCsrf();

      // Accept once
      await request(app)
        .post('/auth/accept-invitation')
        .set('Cookie', csrfCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(
          `_csrf=${encodeURIComponent(csrfToken)}` +
          `&token=${encodeURIComponent(rawToken)}` +
          `&password=${encodeURIComponent('FirstPass1!')}` +
          `&confirmPassword=${encodeURIComponent('FirstPass1!')}`,
        );

      // Try to accept again
      const { token: t2, cookie: c2 } = await getCsrf();
      const res2 = await request(app)
        .post('/auth/accept-invitation')
        .set('Cookie', c2)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(
          `_csrf=${encodeURIComponent(t2)}` +
          `&token=${encodeURIComponent(rawToken)}` +
          `&password=${encodeURIComponent('SecondPass1!')}` +
          `&confirmPassword=${encodeURIComponent('SecondPass1!')}`,
        );

      expect(res2.status).toBe(400);
      expect(res2.text).toMatch(/already been used|invalid|expired/i);
    } finally {
      await cleanupUser(invEmail);
      await cleanupInvitation(invEmail);
    }
  });

  // ── User management actions ────────────────────────────────────────────────

  it('GET /owner/users/:id → 200 for OWNER', async () => {
    if (!dbAvailable) return;
    const { sessionCookie } = await loginAs(T.owner);
    const db = getDb();
    const [target] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, T.user))
      .limit(1);

    if (!target) return; // skip if target not seeded
    const res = await request(app)
      .get(`/owner/users/${target.id}`)
      .set('Cookie', sessionCookie)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('POST /owner/users/:id/role → OWNER can change USER role to EDITOR', async () => {
    if (!dbAvailable) return;
    const targetEmail = 'test.1c.role.target@isf-test.local';
    try {
      await cleanupUser(targetEmail);
      const targetId = await createUser(targetEmail, 'USER');
      const { sessionCookie, csrfToken } = await loginAs(T.owner);

      const res = await request(app)
        .post(`/owner/users/${targetId}/role`)
        .set('Cookie', sessionCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=${encodeURIComponent(csrfToken)}&role=EDITOR`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(/success=role-changed/);

      const db = getDb();
      const [updated] = await db
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .limit(1);
      expect(updated?.role).toBe('EDITOR');
    } finally {
      await cleanupUser(targetEmail);
    }
  });

  it('POST /owner/users/:id/disable → OWNER can disable a USER account', async () => {
    if (!dbAvailable) return;
    const targetEmail = 'test.1c.disable.target@isf-test.local';
    try {
      await cleanupUser(targetEmail);
      const targetId = await createUser(targetEmail, 'USER');
      const { sessionCookie, csrfToken } = await loginAs(T.owner);

      const res = await request(app)
        .post(`/owner/users/${targetId}/disable`)
        .set('Cookie', sessionCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=${encodeURIComponent(csrfToken)}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(/success=disabled/);

      const db = getDb();
      const [updated] = await db
        .select({ isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .limit(1);
      expect(updated?.isActive).toBe(false);
    } finally {
      await cleanupUser(targetEmail);
    }
  });

  it('POST /owner/users/:id/reactivate → OWNER can reactivate a disabled account', async () => {
    if (!dbAvailable) return;
    const targetEmail = 'test.1c.reactivate.target@isf-test.local';
    try {
      await cleanupUser(targetEmail);
      const targetId = await createUser(targetEmail, 'USER');
      const { sessionCookie, csrfToken } = await loginAs(T.owner);

      // First disable
      await request(app)
        .post(`/owner/users/${targetId}/disable`)
        .set('Cookie', sessionCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=${encodeURIComponent(csrfToken)}`);

      // Then reactivate
      const { sessionCookie: s2, csrfToken: t2 } = await loginAs(T.owner);
      const res = await request(app)
        .post(`/owner/users/${targetId}/reactivate`)
        .set('Cookie', s2)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=${encodeURIComponent(t2)}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(/success=reactivated/);

      const db = getDb();
      const [updated] = await db
        .select({ isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .limit(1);
      expect(updated?.isActive).toBe(true);
    } finally {
      await cleanupUser(targetEmail);
    }
  });

  // ── Revoke invitation ─────────────────────────────────────────────────────

  it('POST /owner/invitations/:id/revoke → OWNER can revoke a pending invitation', async () => {
    if (!dbAvailable) return;
    const invEmail = 'revoke.inv.1c@isf-test.local';
    try {
      await cleanupInvitation(invEmail);
      const db = getDb();
      const [o] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, T.owner))
        .limit(1);
      const ownId = o?.id ?? ownerId;

      const { invitationId } = await createInvitationRecord(invEmail, 'USER', ownId);
      const { sessionCookie, csrfToken } = await loginAs(T.owner);

      const res = await request(app)
        .post(`/owner/invitations/${invitationId}/revoke`)
        .set('Cookie', sessionCookie)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=${encodeURIComponent(csrfToken)}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(/success=revoked/);

      // Verify in DB
      const [inv] = await db
        .select({ revokedAt: invitationsTable.revokedAt })
        .from(invitationsTable)
        .where(eq(invitationsTable.id, invitationId))
        .limit(1);
      expect(inv?.revokedAt).not.toBeNull();
    } finally {
      await cleanupInvitation(invEmail);
    }
  });

  // ── OWNER login redirect ──────────────────────────────────────────────────

  it('OWNER login → redirects to /owner', async () => {
    if (!dbAvailable) return;
    const { token, cookie: csrfCookie } = await getCsrf();

    const res = await request(app)
      .post('/auth/login')
      .set('Cookie', csrfCookie)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Accept', 'text/html')
      .send(
        `_csrf=${encodeURIComponent(token)}&email=${encodeURIComponent(T.owner)}&password=${encodeURIComponent(TEST_PASSWORD)}`,
      );

    // Browser form login redirects
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/owner/);
  });
});
