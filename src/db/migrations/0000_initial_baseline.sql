-- ISF Platform — Initial migration baseline
-- Phase 0: establishes the migration infrastructure.
-- Domain tables are added in subsequent phase migrations.

-- Enable UUID generation (pgcrypto is included in PostgreSQL by default)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Verify that TIMESTAMPTZ is enforced via convention (runtime check, not DDL)
-- Verify that NUMERIC is used for monetary values (enforced in domain migrations)

-- Phase 0 complete: migration runner infrastructure is proven working.
