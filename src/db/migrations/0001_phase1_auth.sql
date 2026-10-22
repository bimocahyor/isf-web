-- ISF Platform — Phase 1 migration: authentication and audit
-- Creates: users, sessions, audit_logs tables

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email           TEXT        NOT NULL,
  password_hash   TEXT        NOT NULL,
  display_name    TEXT        NOT NULL DEFAULT '',
  role            TEXT        NOT NULL DEFAULT 'USER'
                              CHECK (role IN ('ADMIN','EDITOR','REVIEWER','USER')),
  email_verified_at TIMESTAMPTZ,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email))
  WHERE deleted_at IS NULL;

CREATE INDEX users_email_idx ON users (LOWER(email));
CREATE INDEX users_role_idx  ON users (role);

-- ---------------------------------------------------------------------------
-- sessions (connect-pg-simple schema)
-- connect-pg-simple expects exactly this structure
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  sid     TEXT        NOT NULL PRIMARY KEY,
  sess    JSONB       NOT NULL,
  expire  TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_expire_idx ON sessions (expire);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_id    UUID,           -- NULL for anonymous / system events
  actor_email TEXT,           -- snapshot of email at the time of the event
  action      TEXT        NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  ip_address  INET,
  user_agent  TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
