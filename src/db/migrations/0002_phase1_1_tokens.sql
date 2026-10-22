-- ISF Platform — Phase 1.1 migration: password reset tokens and email verification tokens

-- ---------------------------------------------------------------------------
-- email_verification_tokens
-- ---------------------------------------------------------------------------
-- Stores a SHA-256 hash of the raw token (never the raw token itself).
-- One pending token per user at a time — old tokens are deleted on re-send.
-- ---------------------------------------------------------------------------
CREATE TABLE email_verification_tokens (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,   -- SHA-256 hex of the raw token
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX evt_user_id_idx ON email_verification_tokens (user_id);
CREATE INDEX evt_expires_at_idx ON email_verification_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- password_reset_tokens
-- ---------------------------------------------------------------------------
-- Stores a SHA-256 hash of the raw token (never the raw token itself).
-- Single-use: used_at is set on redemption, token cannot be reused.
-- One active token per user — previous tokens are invalidated on new request.
-- ---------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,   -- SHA-256 hex of the raw token
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,            -- set when token is redeemed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX prt_user_id_idx   ON password_reset_tokens (user_id);
CREATE INDEX prt_expires_at_idx ON password_reset_tokens (expires_at);
