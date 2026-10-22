# ADR-005: Deployment Architecture

**Status:** Proposed (Phase 7)  
**Date:** 2025

## Overview

Phase 0 establishes local development infrastructure only. This ADR documents the production deployment target for Phase 7.

## Target Architecture

```
Internet → Nginx (TLS termination) → Node.js process (PM2) → PostgreSQL
                                                            → S3 / R2 (storage)
                                                            → SMTP provider (email)
```

## Server

**Option A (Preferred for cost): VPS**
- Provider: Hetzner Cloud (CCX series) or DigitalOcean
- Minimum: 2 vCPU, 4 GB RAM
- OS: Ubuntu 22.04 LTS
- Process manager: PM2 (cluster mode for zero-downtime restart)

**Option B: PaaS**
- Railway or Render for simplified deployments
- Managed PostgreSQL add-on
- Suitable if operational overhead of VPS management is a concern

## TLS

- Let's Encrypt via Certbot
- Auto-renewal via systemd timer or cron
- Nginx handles TLS termination; Node.js listens on localhost only
- HSTS header with 1-year max-age after verification

## Database

- Managed PostgreSQL (Supabase, Neon, or DigitalOcean Managed Database)
- Private network connection between app server and database
- Daily automated backups with 30-day retention
- Point-in-time recovery (PITR) enabled
- Encrypted backups at rest

## File Storage

- Cloudflare R2 (preferred: zero egress fees) or AWS S3
- Two buckets: private documents + public assets
- IAM credentials with minimum required permissions
- Stored in environment variables only — never in source code

## Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name intelegensia.id www.intelegensia.id;

    # Static files cached at Nginx level
    location /css/ { ... }
    location /js/ { ... }
    location /assets/ { ... }

    # All other requests to Node.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
    }
}
```

## CI/CD

- GitHub Actions triggers on merge to `main`
- CI: install → lint → typecheck → tests
- CD: SSH deploy script (pull, npm ci, build, pm2 reload)
- Secrets in GitHub Actions Secrets — never in repository
- No automatic deployment to production from feature branches

## Environment Variables

All configuration via environment variables. Never hard-coded values for:
- Database connection
- Session secret
- Payment gateway keys
- SMTP credentials
- Storage access keys
- Production domain

## Never Do

- Never store database dumps in the repository
- Never commit `.env` files
- Never push to production from a local machine (only CI/CD)
- Never use the same DATABASE_URL in development and production
- Never expose the Node.js port directly to the internet (always via Nginx)

## RPO and RTO Targets

| Metric | Target |
|--------|--------|
| Recovery Point Objective (RPO) | 24 hours (daily backup) |
| Recovery Time Objective (RTO) | 4 hours |
| Backup testing | Monthly restore drill |

See `docs/deployment/backup-strategy.md` for implementation details.
