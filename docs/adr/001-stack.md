# ADR-001: Technology Stack

**Status:** Accepted
**Date:** 2025
**Updated:** 2026 — Node.js 24.21.0 LTS (codename Krypton) confirmed installed and verified
**Author:** Platform Team

## Context

The ISF platform is evolving from a static HTML/CSS/JS landing page into a full-stack scholarship and fundraising platform. A technology stack must be chosen that:

- Is appropriate for a single-organization production application
- Supports the security requirements (auth, RBAC, financial integrity)
- Allows the team to move quickly without over-engineering early
- Can be operated and maintained by a small team
- Is production-deployable on a VPS or PaaS

## Decision

### Runtime: Node.js 24 LTS

Node.js is the natural choice given the existing JavaScript frontend. The same language across frontend and backend reduces context-switching. Version 24 (LTS) provides long-term security support.

### Language: TypeScript (strict mode)

TypeScript with `strict: true` provides:
- Compile-time detection of type errors in financial calculations, RBAC checks, and schema definitions
- Better IDE support and refactoring safety
- Self-documenting interfaces and function signatures

TypeScript does not replace runtime validation. All external input (HTTP requests, environment variables) is validated with Zod at runtime.

### Web Framework: Express 5

Express 5 is chosen over NestJS, Hono, or Fastify because:
- Mature, stable, and extremely well-understood
- Minimal magic — errors are easy to trace
- Large ecosystem of compatible middleware
- Express 5 adds native async error handling (no need for express-async-errors)

NestJS is explicitly excluded: it adds significant abstraction overhead and DI framework complexity that is not justified at this scale.

### Template Engine: Nunjucks

Server-side rendering with Nunjucks for portal and admin pages provides:
- HTML rendered server-side with auth context (no SPA hydration complexity)
- Auto-escaping by default (XSS protection)
- Simple, readable templates that can be maintained without JS build tooling
- The existing landing page visual identity can be shared via CSS custom properties

### Database ORM: Drizzle ORM

Drizzle provides:
- Type-safe SQL query building
- Migration file generation
- No hidden magic — the generated SQL is readable and predictable
- PostgreSQL-first design

### Validation: Zod

Zod is used for:
- Runtime environment variable validation at startup
- Request body and query parameter validation
- Shared schema definitions between frontend and backend in future phases

### Password Hashing: Argon2id

Argon2id is the recommended algorithm from OWASP for new systems:
- Memory-hard (resistant to GPU/ASIC attacks)
- Preferred over bcrypt for new applications
- Available via the `argon2` npm package

### Logging: Pino

Pino provides:
- Structured JSON logging in production
- Pino-pretty for human-readable development output
- Low overhead (significantly faster than Winston)
- Built-in support for sensitive field redaction

### Testing: Vitest + Supertest

- Vitest: fast, TypeScript-native test runner with Jest-compatible API
- Supertest: HTTP integration testing without starting a real server

Playwright is reserved for future E2E browser testing when the portal UI is implemented.

### Package Manager: npm

npm is used to minimize toolchain complexity. No pnpm or yarn.

## Alternatives Considered

| Alternative | Reason Rejected |
|-------------|-----------------|
| Next.js / Remix | React-SPA overhead; not justified for a server-rendered portal |
| NestJS | DI framework magic; steep learning curve; over-engineered for this scale |
| MySQL / MariaDB | PostgreSQL has superior support for UUID, JSONB, TIMESTAMPTZ, NUMERIC |
| MongoDB | No ACID transactions; unsuitable for financial ledger data |
| Prisma ORM | Less control over SQL; migration workflow less explicit than Drizzle |
| Redis (sessions) | PostgreSQL-backed sessions are sufficient at this scale; avoids extra infrastructure |
| JWT sessions | Cannot be revoked; unacceptable for financial/document platform |

## Consequences

- The team must maintain TypeScript compilation discipline (no `any` casts in business logic)
- Drizzle migrations must be committed and reviewed like code
- The Nunjucks SSR approach means a future SPA migration would require API-first refactoring, but the `/api/v1/` prefix is already reserved for this
