# ADR-003: Authentication

**Status:** Accepted  
**Date:** 2025

## Decision

Server-side session authentication using:
- Argon2id for password hashing
- PostgreSQL-backed server-side sessions (connect-pg-simple)
- HTTP-only, Secure, SameSite=Strict cookies
- Signed, time-limited tokens for email verification and password reset (stored hashed)

## Why Not JWT for Sessions

JWT-based sessions are explicitly rejected for the main session mechanism:

1. **JWTs cannot be revoked** before their expiry time. This means a stolen token remains valid until it expires — unacceptable for a platform handling financial data and sensitive documents.
2. **Session revocation is a core requirement**: admins must be able to force-logout users, and users must be able to logout from all devices.
3. **PostgreSQL-backed sessions provide this** with minimal overhead at ISF's scale.

JWTs may be used for short-lived, single-use tokens (e.g., email verification links, password reset links) where revocation-on-use is enforced.

## Password Hashing

Argon2id is used with the following OWASP-recommended parameters (to be tuned per deployment hardware):
- `m` (memory): ≥ 19 MiB (19456 KiB)  
- `t` (iterations): ≥ 2  
- `p` (parallelism): 1  

The hash is stored in the `password_hash` column of the `users` table.
The raw password is NEVER stored, logged, or transmitted in any internal channel.

## Session Storage

Sessions are stored in a `sessions` table in PostgreSQL via `connect-pg-simple`.
The session cookie contains only the session ID — no user data is stored in the cookie.
Session ID is a cryptographically random value (128-bit minimum).

Cookie settings:
```
httpOnly: true
secure: true (production) / false (development)
sameSite: 'strict'
maxAge: 30 days (sliding, renewed on activity)
```

## Session Regeneration

The session ID is regenerated:
- On login (prevent session fixation)
- On privilege change (role assignment)
- On logout (session is deleted from DB)

## Email Verification

1. On registration, user is created with `email_verified_at = NULL`.
2. A verification token is generated: `crypto.randomBytes(32)`.
3. A SHA-256 hash of the token is stored in `email_verification_tokens`.
4. The raw token is included in a verification link emailed to the user.
5. On link click, the submitted token is hashed and compared.
6. On match: set `email_verified_at = NOW()`, delete the token record.
7. Token expires in 24 hours.

## Password Reset

1. User submits their email address.
2. Server looks up the user. Response is ALWAYS generic ("if this email exists, a link was sent") — do not confirm or deny account existence.
3. A reset token is generated: `crypto.randomBytes(32)`.
4. SHA-256 hash stored in `password_reset_tokens` with a 1-hour expiry.
5. Raw token in a signed reset link emailed to user.
6. On use: verify hash match, verify not expired, update password hash, mark token used, invalidate all existing sessions for that user.

## Rate Limiting on Auth Endpoints

All authentication endpoints have tighter rate limiting than the global limit:
- `POST /auth/login`: 10 attempts per 15 minutes per IP
- `POST /auth/register`: 5 per hour per IP  
- `POST /auth/forgot-password`: 5 per hour per IP

## Security Events to Audit Log

All of the following must produce audit log entries:
- Successful login
- Failed login (with IP)
- Logout
- Password change
- Password reset requested
- Password reset completed
- Email verification completed
- Account creation
- Account soft-delete
- Role change

## Implementation Phase

Phase 1.
