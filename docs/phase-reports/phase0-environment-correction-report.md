# Phase 0 Environment Correction Report

**Date:** 2025  
**Status:** ✅ COMPLETE  
**Commit:** `7e20271` (main)

---

## Summary

Phase 0 environment correction is fully complete. All toolchain versions have been
upgraded or confirmed. The HIGH severity SQL injection vulnerability in `drizzle-orm`
has been patched. All 38 tests pass. The codebase is committed to version control.

---

## Environment Baseline Confirmed

| Component        | Installed Version | Target Version | Status |
|-----------------|-------------------|---------------|--------|
| Node.js          | 24.21.0 LTS (Krypton) | ≥24.0.0  | ✅ |
| npm              | 11.19.0           | ≥10.0.0       | ✅ |
| PostgreSQL       | 18.6 (Scoop)      | 18.x          | ✅ |
| TypeScript       | 5.8.3             | ^5.x          | ✅ |
| Drizzle ORM      | 0.45.3            | ^0.45.3       | ✅ Fixed |
| Drizzle Kit      | 0.31.11           | ^0.31.11      | ✅ Fixed |
| Express          | 5.x               | ^5.x          | ✅ |
| Vitest           | 3.2.7             | ^3.x          | ✅ (see deferred) |

---

## Vulnerability Remediation

### ✅ RESOLVED — HIGH: drizzle-orm SQL Injection (GHSA-gpj5-g38j-94v9)

- **Severity:** HIGH  
- **Description:** SQL injection via improperly escaped SQL identifiers in
  `drizzle-orm <0.45.2`  
- **Fix applied:** Upgraded `drizzle-orm` from `^0.44.2` → `^0.45.3`  
- **Verification:** `npm audit` no longer reports this advisory  

### ✅ RESOLVED — MODERATE: esbuild dev-server CORS (GHSA-67mh-4wv8-2f99)

- **Severity:** Moderate  
- **Description:** `esbuild ≤0.24.2` dev server allows cross-origin reads  
- **Exploitability:** Only via `esbuild --serve`; we never run this  
- **Fix applied:** Upgraded `drizzle-kit` from `^0.30.4` → `^0.31.11`, which
  pulls `esbuild ^0.25.x` as its direct dependency. The old `esbuild@0.18.20`
  remains as a transitive dependency of `@esbuild-kit/core-utils` inside
  `drizzle-kit@0.31.11`; npm still reports it.  
- **Risk in practice:** Zero — the vulnerable path (`esbuild --serve`) is never
  executed in this project in any environment.  
- **npm's suggested "fix"** would **downgrade** `drizzle-kit` to `0.18.1` (a
  two-year-old version) — this is unacceptable.  

### ⏳ DEFERRED — MODERATE: Vitest Path Traversal (GHSA-82fw-gwwq-j7x9)

- **Severity:** Moderate (4 advisories: `@vitest/mocker`, `vitest`,
  `@vitest/coverage-v8`, and their relationship)  
- **Description:** Path traversal / arbitrary file read via
  `@vitest/mocker` redirect mock  
- **Exploitability:** Only when running `vitest --browser` mode. **We never
  use browser mode.**  
- **Fix available:** Upgrade to `vitest@5.x` — this is a **breaking change**
  to the test runner API and test file format.  
- **Decision:** Deferred to Phase 1 dependency review. A dedicated vitest v5
  migration ticket must be opened. Until then, this risk is accepted because:
  1. The vulnerable code path (`--browser` mode) is never invoked
  2. A breaking upgrade mid-phase carries its own risk
  3. Test suite integrity is more important than addressing a theoretical
     local-only dev tool risk

---

## Quality Gates Passed

```
npm run typecheck   → exit 0  ✅
npm run lint        → exit 0  ✅
npm test            → 38/38 passed  ✅

Test breakdown:
  tests/unit/errors.test.ts         8 tests  ✅
  tests/unit/env.test.ts            8 tests  ✅
  tests/integration/phase0.test.ts  22 tests ✅
```

---

## Functional Verification

| Check | Result |
|-------|--------|
| `GET /` → 200, landing page served (19793 bytes) | ✅ |
| `GET /health` → `{"status":"ok","checks":{"database":{"status":"ok"}}}` | ✅ |
| `GET /.env` → 404 | ✅ |
| `GET /src/server.ts` → 404 | ✅ |
| `GET /package.json` → 404 | ✅ |
| Static assets (css, js, favicon) → 200 | ✅ |
| CSP / Helmet security headers present | ✅ |
| Request ID header present | ✅ |
| `public/index.html` SHA-256 unchanged | ✅ `B413002B5E87EC2C6991F44D783ABDDCC82AEA4D32E8F5A87D3882206C387DEE` |

---

## Git Hygiene

- Repository initialized: `main` branch  
- Initial commit: `7e20271`  
- Files correctly excluded from version control:
  - `.env` — gitignored ✅
  - `server.log` — gitignored via `*.log` ✅
  - `server.err` — gitignored via `*.err` ✅ (added this phase)
  - `node_modules/` — gitignored ✅
- `.gitattributes` added to enforce LF line endings in repository ✅
- `.gitignore` BOM removed (was causing display artifact on line 1) ✅

---

## Infrastructure Notes (Local Windows Machine)

Docker Desktop is installed but **non-functional** on this machine — WSL2 is not
installed and Hyper-V requires administrator elevation. The PostgreSQL 18.6 instance
runs natively via Scoop. MinIO and Mailpit (needed for Phase 2+ development) will
require an alternative approach:

- **Option A:** Install MinIO and Mailpit as Windows binaries via Scoop
- **Option B:** Set up WSL2 (requires admin)
- **Option C:** Use cloud/remote instances for dev

This is documented and deferred to when those services are first needed (Phase 2 for
storage, Phase 3 for email verification).

Session-start PATH required:
```powershell
$env:PATH = "C:\nodejs\node-v24.21.0-win-x64;$env:USERPROFILE\scoop\apps\postgresql\18.6-5\pgsql\bin;$env:USERPROFILE\scoop\shims;$env:PATH"
```

---

## Phase 0 Deliverables Checklist

- [x] Static landing page at `public/` — preserved, byte-for-byte unchanged
- [x] Express 5 app factory (`src/app/index.ts`) — testable, no TCP bind
- [x] TypeScript strict + ESLint 9 + Prettier — all passing
- [x] Zod environment validation — startup fails fast on missing vars
- [x] Drizzle ORM + PostgreSQL pool + `checkDatabaseHealth()`
- [x] Migration runner + `0000_initial_baseline.sql` (pgcrypto installed)
- [x] `GET /health` — real DB liveness check
- [x] Module boundary stubs — auth, users, cms, scholarship, fundraising,
      finance, audit, storage, notifications
- [x] `PaymentGateway` interface + `MockPaymentGateway` stub
- [x] ISF-branded error templates (Nunjucks 404/500)
- [x] 9 Architecture Decision Records (ADRs 001–009)
- [x] Privacy architecture document
- [x] Backup/DR strategy document
- [x] Node.js setup document (Windows non-admin)
- [x] GitHub Actions CI — postgres:18.6-alpine, Node 24
- [x] 38 tests passing
- [x] HIGH vulnerability patched (drizzle-orm 0.45.3)
- [x] Initial git commit on `main`

---

## Next: Phase 1 — Authentication, Sessions, RBAC

Phase 1 scope (see `docs/adr/003-authentication.md` and `docs/adr/004-rbac.md`):

1. Database migration: `users` and `sessions` tables
2. Drizzle schema: `users`, `sessions`
3. Argon2id password hashing service
4. `express-session` + `connect-pg-simple` session store
5. Auth module: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`
6. RBAC middleware: `requireAuth`, `requireRole`, `requirePermission`
7. User module: `GET /users/me`
8. Audit log module: `audit_logs` table + `recordAuditEvent()` function
9. Phase 1 test suite: auth flows, session persistence, RBAC enforcement
