-- 001: platform identity
-- Who can sign in, and the record of what they did.
-- This is the only table family that stores anything about a natural person as
-- a natural person. Everything in the demand tables is pseudonymised.

CREATE TABLE app_user (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  email_normalised TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'analyst', 'viewer')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at   TEXT
);

-- Sessions store only a hash of the cookie token. A database disclosure
-- therefore does not hand an attacker usable session cookies.
CREATE TABLE app_session (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip_hash         TEXT,
  user_agent_hash TEXT
);

CREATE INDEX idx_app_session_user ON app_session(user_id);
CREATE INDEX idx_app_session_expiry ON app_session(expires_at);

-- Password reset tokens. Single use, short lived, and stored only as a hash.
-- A reset flow that stores a usable token is a password reset flow that can be
-- replayed from a database copy, so the token is HMAC'd with the session secret
-- before it is written, exactly as sessions are.
CREATE TABLE password_reset (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX idx_password_reset_user ON password_reset(user_id);
CREATE INDEX idx_password_reset_expiry ON password_reset(expires_at);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
