-- ISF Platform — Phase 1C migration: add OWNER to users role check constraint

-- Drop the old constraint that only allows ADMIN, EDITOR, REVIEWER, USER
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- Add new constraint that includes OWNER
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'USER'));
