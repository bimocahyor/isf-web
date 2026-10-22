# Backup and Disaster Recovery Strategy

**Status:** Design Document (implement in Phase 7)  
**Date:** 2025

## Objectives

| Metric | Target | Description |
|--------|--------|-------------|
| RPO (Recovery Point Objective) | 24 hours | Maximum acceptable data loss |
| RTO (Recovery Time Objective) | 4 hours | Maximum acceptable downtime |
| Backup Retention | 30 days | How long backups are kept |

---

## Database Backup

### Strategy: Managed PostgreSQL with PITR

Use a managed PostgreSQL service (Supabase, Neon, or DigitalOcean Managed Database) that provides:
- **Automated daily base backups**
- **Write-Ahead Log (WAL) streaming** for point-in-time recovery
- **Encryption at rest** for all backup data
- **Geo-redundant backup storage** (different region from primary)

### Backup Schedule
- Full base backup: daily (automated by managed service)
- WAL archiving: continuous (every 5 minutes of WAL, or managed service default)
- Retention: 30 days

### What Is Backed Up
- All PostgreSQL tables (schema + data)
- All indexes, sequences, functions, triggers
- Extension state (e.g., pgcrypto)

### What Is NOT Backed Up in Database
- Application source code (Git repository is the source)
- Static assets in S3/R2 (backed up separately)
- `.env` files (must be stored securely in a secrets manager, not Git)

---

## Object Storage Backup

### Strategy: S3 Cross-Region Replication + Versioning

For AWS S3 or Cloudflare R2:
- Enable **versioning** on the private documents bucket (`isf-private-docs`)
- Enable **cross-region replication** to a separate region (RPO: near-zero for object storage)
- 30-day version retention (soft-deleted objects retained for 30 days)

For MinIO (local dev): no backup required — local development data is ephemeral.

---

## Application Code

Source code is in Git (GitHub). No backup required beyond standard Git practices:
- Main branch is protected (no direct push)
- All changes via pull requests
- At least one reviewer required

---

## Restore Testing

### Monthly Restore Drill
1. Select a backup from 7 days prior
2. Restore to a **separate test environment** (never production)
3. Verify schema integrity: `pg_dump --schema-only`
4. Verify row counts on critical tables match expected values
5. Run smoke tests against the restored environment
6. Document the restore time (must be < 4 hours)
7. Record results in a restore log

---

## Disaster Recovery Runbook

### Scenario: Database Corruption or Accidental DROP

1. **Stop the application** to prevent further writes
2. **Identify the restore target time**: last known good state
3. **Initiate PITR restore** via managed database provider console
4. **Verify the restored database**: run smoke queries
5. **Update `DATABASE_URL`** in environment to point to restored instance
6. **Restart application**
7. **Audit log review**: identify what caused the incident
8. **Post-incident report**: root cause, timeline, prevention measures

### Scenario: Server Loss

1. **Provision new server** (Terraform or manual — document which)
2. **Install Node.js, Nginx, PM2**
3. **Clone repository from GitHub**
4. **Restore `.env`** from secure secrets storage (not Git)
5. **Run migrations** against the backup database
6. **Update DNS** to new server IP
7. **Verify TLS renewal**
8. **Smoke test all critical paths**

---

## Secrets Management (Production)

Secrets are NEVER stored in:
- The Git repository
- Plaintext on disk on the application server
- Application logs

Secrets are stored in:
- A secure secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager, or a securely managed `.env` on the production server accessible only to the deploy user)
- GitHub Actions Secrets (for CI/CD deployment keys only)

---

## Never Do

- Never store database dumps in the Git repository
- Never restore production data into development environments
- Never use production DATABASE_URL in local development
- Never skip the monthly restore drill
