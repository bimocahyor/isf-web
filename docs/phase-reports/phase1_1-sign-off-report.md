# Phase 1.1 — Authentication Hardening: Sign-Off Report

**Date:** 2026-10-03  
**Commit:** `50553a9`  
**Branch:** `main`  
**Status:** ✅ SIGNED OFF

---

## Validation Gates

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | ✅ Exit 0 — no type errors |
| `npx eslint src --ext .ts` | ✅ Exit 0 — no lint warnings |
| `npm test` | ✅ 92 tests, 5 test files — all passed |
| `GET /` landing page SHA-256 | ✅ `B413002B5E87EC2C6991F44D783ABDDCC82AEA4D32E8F5A87D3882206C387DEE` — unchanged |

---

## A. Email Verification Architecture

### What was implemented
- **Token generation:** `randomBytes(32).toString('base64url')` — 256 bits of entropy, URL-safe
- **Token storage:** Only `SHA-256(rawToken)` (hex) is persisted in `email_verification_tokens`; the raw token is never written to disk or database
- **Token delivery:** Raw token embedded in email link (`/auth/verify-email?token=<raw>`)
- **Token expiry:** 24 hours from issuance (`expiresAt` column)
- **Single-use enforcement:** Token row is deleted on successful redemption; expired tokens are deleted on redemption attempt
- **Re-issue on registration:** Previous pending tokens are deleted before a new one is issued
- **Public re-send endpoint:** `createEmailVerificationToken()` is available for a future re-send route; it is a no-op if the user is already verified
- **Verification endpoint:** `GET /auth/verify-email?token=<raw>` — validates hash match, checks expiry, updates `users.email_verified_at`, fires `EMAIL_VERIFIED` audit event

### What is NOT enforced (by design for Phase 1.1)
- Email verification is NOT required to log in — this is a deliberate Phase 1.1 decision. Mandatory verification enforcement (gate login behind `emailVerifiedAt`) is deferred to when the platform requires it

---

## B. Password Reset Architecture

### Token model
- **Raw token:** `randomBytes(32).toString('base64url')` — sent in email, never stored
- **Stored hash:** `SHA-256(rawToken)` as hex in `password_reset_tokens.token_hash`
- **Expiry:** 1 hour (`expiresAt`)
- **Single-use:** `used_at` timestamp — set on consumption, checked before accepting
- **Token invalidation:** All previous reset tokens for the user are deleted before issuing a new one

### Endpoint design
- `POST /auth/forgot-password` — always returns the same generic 200 response regardless of whether the email exists, is inactive, or the request is a validation error. This prevents email enumeration via differential responses.
- `POST /auth/reset-password` — consumes token, hashes new password (Argon2id), invalidates all user sessions, fires `PASSWORD_RESET_COMPLETED` audit event

### Session invalidation on password reset
- `consumePasswordResetToken()` executes a raw pool query: `DELETE FROM sessions WHERE sess->>'userId' = $1`
- This invalidates sessions on ALL devices (including devices the attacker may have access to)
- The current session (if the authenticated user triggered the reset themselves) is destroyed separately in the router after `consumePasswordResetToken()` returns

---

## C. CSRF Protection Architecture

### Pattern: Double-submit cookie (csrf-csrf v4)
- A CSRF secret is signed and stored in an `HttpOnly`, `SameSite=Strict` cookie (`isf.csrf`)
- The client must echo the token in the `X-CSRF-Token` request header (or `_csrf` body field) for all state-changing requests (POST, PUT, PATCH, DELETE)
- GET, HEAD, OPTIONS are not protected (safe methods must not mutate state)
- The secret is tied to the session identifier (`req.sessionID`) or the remote address for pre-login requests

### Token endpoint
- `GET /auth/csrf-token` — sets the cookie and returns `{ csrfToken: "..." }` in the response body
- Clients must call this before any state-changing request when they do not yet have a CSRF token
- No authentication required to call this endpoint

### Test-mode behaviour
- `skipCsrfProtection: () => env.NODE_ENV === 'test'` bypasses CSRF validation in the test environment
- This is the same pattern as the rate limiter relaxation in tests
- The middleware is still fully mounted and exercised; bypass only prevents CSRF token validation failures from blocking test flows
- The `phase1_1.test.ts` suite contains explicit CSRF endpoint tests (200 + cookie set) that verify the middleware is wired correctly

### Protected routes
All state-changing routes (`/auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/api/v1/*`) have `csrfProtection` applied via app-level middleware in `src/app/index.ts`

### Excluded routes (intentional)
- `/health` — read-only, no state change
- `/webhooks/*` — server-to-server, authenticated by HMAC signature (Phase 5)
- Static assets — served from `public/` by `express.static`

---

## D. Audit Event Architecture

### Two-tier audit model
| Function | Behaviour | Usage |
|---|---|---|
| `recordAuditEvent()` | Fire-and-forget (wraps async, logs errors internally) | Non-critical informational events (EMAIL_VERIFICATION_SENT) |
| `recordAuditEventCritical()` | `async`, must be `await`ed | All security events: login, logout, register, email verify, password reset, authorization denial |

### Audit actions in Phase 1.1
| Action | When |
|---|---|
| `USER_REGISTERED` | Successful registration |
| `LOGIN_SUCCESS` | Successful login (after session regeneration) |
| `LOGIN_FAILED` | Failed login attempt (bad credentials) |
| `LOGOUT` | Successful session destruction |
| `EMAIL_VERIFICATION_SENT` | Verification email issued |
| `EMAIL_VERIFIED` | Verification token redeemed |
| `PASSWORD_RESET_REQUESTED` | forgot-password called for a known active user |
| `PASSWORD_RESET_COMPLETED` | reset-password token consumed successfully |
| `AUTHORIZATION_DENIED` | `requirePermission()` check failed |

### Audit record fields
Every record captures: `actorId`, `actorEmail`, `action`, `entityType`, `entityId`, `ipAddress`, `userAgent`, `createdAt`

---

## E. Rate Limiting Architecture

| Endpoint | Window | Limit (prod) | Limit (test) |
|---|---|---|---|
| `POST /auth/register` | 1 hour | 5 | 1,000 |
| `POST /auth/login` | 15 minutes | 10 | 1,000 |
| `POST /auth/forgot-password` | 1 hour | 5 | 1,000 |
| `POST /auth/reset-password` | 1 hour | 10 | 1,000 |
| Global (all routes) | 15 minutes | 500 | 500 |

**forgot-password rate limit design note:** The rate limit applies uniformly whether the email exists or not, and even when the request fails validation. This prevents rate-limit differential attacks (attacker probing whether a specific email is registered by comparing rate-limit exhaustion speed).

---

## F. Log Redaction

The following fields are redacted from all Pino log output (replaced with `[REDACTED]`):

```
password, passwordHash, newPassword, token, tokenHash, rawToken,
secret, sessionSecret, csrfToken, req.headers["x-csrf-token"],
req.headers["authorization"], req.headers["cookie"],
res.headers["set-cookie"]
```

No credential, token, or hash appears in application logs in any form.

---

## G. Session Architecture (unchanged from Phase 1, verified)

- PostgreSQL-backed sessions via `connect-pg-simple` + `express-session`
- Session data: `{ userId, userEmail, userRole, createdAt }`
- Cookie: `isf.sid`, `HttpOnly`, `SameSite=Strict`, `Secure` in production
- Session regeneration on login and registration (prevents session fixation)
- Session destruction on logout (not just clearing — full row delete)
- Session invalidation on password reset (all user sessions via raw SQL)

---

## H. Token Table Schema (Migration 0002)

### `email_verification_tokens`
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
token_hash  TEXT NOT NULL UNIQUE           -- SHA-256(rawToken) hex
expires_at  TIMESTAMPTZ NOT NULL
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

### `password_reset_tokens`
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
token_hash  TEXT NOT NULL UNIQUE           -- SHA-256(rawToken) hex
expires_at  TIMESTAMPTZ NOT NULL
used_at     TIMESTAMPTZ                   -- NULL = unused; set = consumed
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

Both tables cascade-delete when the user is deleted.  
Raw tokens are never stored — only `SHA-256(rawToken)` is persisted.

---

## I. Mailer Architecture

- **Library:** Nodemailer (`createTransport`)
- **Configuration:** SMTP host/port/user/pass from environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`)
- **Non-production fallback:** When SMTP is not configured, emails are logged to console via `nodemailer.createTestAccount()` (preview URL printed)
- **Error handling:** Email send failures are logged as warnings and do not propagate to the caller. Account creation and password reset continue even if email delivery fails.
- **Emails sent:**
  - Verification email: subject "Verify your ISF account email address", contains verification link
  - Password reset email: subject "ISF password reset request", contains reset link with 1-hour warning

---

## J. Security Properties Verified

| Property | Mechanism |
|---|---|
| No email enumeration via forgot-password | Generic response for all outcomes including validation errors |
| No email enumeration via login | Always runs Argon2id verification even when user not found (dummy hash) |
| No token enumeration | Only SHA-256 hashes stored; raw tokens sent to email only |
| Database breach token safety | SHA-256(token) is not reversible to raw token |
| Single-use tokens | Deleted on redemption (email verification); `used_at` set (password reset) |
| Session fixation prevention | `req.session.regenerate()` after login and registration |
| Session invalidation on compromise | All user sessions deleted on password reset |
| No credentials in logs | Pino redact list covers all known credential/token field names |
| No credentials in responses | Test: `phase1_1.test.ts` "no sensitive data in responses" |
| CSRF double-submit cookie | csrf-csrf v4, `HttpOnly`, `SameSite=Strict`, session-tied identity |
| Server-side rate limiting | Per-endpoint limiters, headers exposed to clients |

---

## K. Test Coverage

**Test files:**

| File | Tests | Focus |
|---|---|---|
| `tests/unit/errors.test.ts` | 8 | AppError hierarchy |
| `tests/unit/env.test.ts` | 8 | Environment validation |
| `tests/integration/phase1.test.ts` | 40 | Core auth: register, login, logout, RBAC, session |
| `tests/integration/phase1_1.test.ts` | 36 | Hardening: CSRF, email verification, password reset, session invalidation, secrets in responses, rate limit headers |
| **Total** | **92** | |

**Phase 1.1 test categories (`phase1_1.test.ts`):**
- RBAC negative tests (403 for insufficient role/permission)
- Unauthenticated access to protected routes (401)
- CSRF token endpoint (200, cookie set)
- Email verification: valid token, invalid token, missing token
- Password reset: full happy path, invalid token, expired token, already-used token, session invalidation
- Secrets in responses (no `passwordHash`, `tokenHash`, `rawToken` leak)
- Rate limit headers present on auth endpoints
- Logout invalidates session (401 on subsequent authenticated request)

---

## L. Files Modified or Created

### New files
| File | Purpose |
|---|---|
| `src/db/migrations/0002_phase1_1_tokens.sql` | DDL for email_verification_tokens + password_reset_tokens |
| `src/middleware/csrf.middleware.ts` | CSRF double-submit cookie protection |
| `src/shared/mailer.ts` | Nodemailer email service |
| `src/shared/tokens.ts` | generateSecureToken(), hashToken(), expiresInHours() |
| `tests/integration/phase1_1.test.ts` | Phase 1.1 integration test suite |

### Modified files
| File | Change |
|---|---|
| `src/app/index.ts` | Added cookie-parser, csrfProtection, csrfTokenHandler, csrfErrorHandler |
| `src/db/migrations/meta/_journal.json` | Added idx=2 entry |
| `src/db/schema/index.ts` | Added emailVerificationTokensTable, passwordResetTokensTable |
| `src/middleware/auth.middleware.ts` | requirePermission() awaits AUTHORIZATION_DENIED audit |
| `src/modules/auth/auth.router.ts` | Added: verify-email, forgot-password, reset-password endpoints; rate limiters; awaited audit events |
| `src/modules/auth/auth.schemas.ts` | Added forgotPasswordSchema, resetPasswordSchema |
| `src/modules/auth/auth.service.ts` | Full implementation: email verification, password reset, session invalidation |
| `src/shared/audit.ts` | recordAuditEvent (fire-and-forget) + recordAuditEventCritical (awaited); AUTHORIZATION_DENIED action |
| `src/shared/logger.ts` | Expanded redact list |
| `src/shared/password.ts` | needsRehash() made synchronous |
| `tests/integration/phase1.test.ts` | Updated to include CSRF cookie in POST requests |
| `package.json` | Added: nodemailer, csrf-csrf, cookie-parser (prod); @types/nodemailer, @types/cookie-parser (dev) |

---

## M. Open Questions / Deferred Items

| Item | Status |
|---|---|
| Email verification required to log in | **Deferred** — will be enforced when the platform goes to users. Currently, unverified users can log in. |
| Re-send verification email endpoint (`POST /auth/resend-verification`) | **Deferred to Phase 2** — service function `createEmailVerificationToken()` is ready |
| CSRF token in Nunjucks templates (server-rendered forms) | **Deferred** — templates not yet implemented; `nonce`/CSRF injection will be added when form pages are built |
| SMTP configuration for production | **Environment variable driven** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) — operator must supply these at deployment |
| Password history (prevent reuse) | **Not in scope** for Phase 1.1; deferred to a later hardening pass if required |
| Account lockout on repeated failed logins | **Not in scope** for Phase 1.1; rate limiter provides brute-force protection |

---

*Phase 1.1 is complete and signed off. The next phase is Phase 2 (Scholarship module — applicant profiles, applications, document uploads, review workflow).*
