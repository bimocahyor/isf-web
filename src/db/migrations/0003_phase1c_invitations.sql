-- ISF Platform — Phase 1C migration: invitations table and user_invitations tracking

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
-- Stores invitation links that allow an owner/admin to invite a new user.
-- Raw token: 32 random bytes, base64url-encoded — sent in email link only.
-- Token hash: SHA-256(rawToken) hex — stored here.
-- A database breach does not expose usable invitation tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Who was invited (email address — user doesn't exist yet)
  email         TEXT        NOT NULL,

  -- What role will be assigned on acceptance
  role          TEXT        NOT NULL DEFAULT 'USER',

  -- Who issued the invitation
  invited_by    UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Secure token (SHA-256 hash of the raw token, never the raw token)
  token_hash    TEXT        NOT NULL,

  -- Expiry (default: 72 hours from creation)
  expires_at    TIMESTAMPTZ NOT NULL,

  -- Acceptance tracking
  accepted_at   TIMESTAMPTZ,
  accepted_by   UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Revocation (owner/admin can revoke before acceptance)
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID        REFERENCES users(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX inv_token_hash_idx ON invitations (token_hash);
CREATE INDEX inv_email_idx            ON invitations (email);
CREATE INDEX inv_invited_by_idx       ON invitations (invited_by);
CREATE INDEX inv_expires_at_idx       ON invitations (expires_at);
