-- 013: provider self-service
-- Let a business owner claim their listing, sign in, and maintain their own
-- details and contact points.
--
-- Two parts. First, the `provider` role joins the account role check: a claimed
-- listing is maintained by the person who owns it, which is a different kind of
-- account from the operators who run the directory. Second, a `business_claim`
-- table records who claimed which listing, how they proved it, and what an
-- operator decided about that proof.
--
-- The role check change needs a table rebuild, which this file declares on the
-- line below. The runner suspends foreign key enforcement around the rebuild and
-- re-checks every key before committing, so the wider `provider` role cannot
-- leave a session dangling.
-- migrate:table_rebuild

CREATE TABLE app_user_new (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  email_normalised TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'analyst', 'viewer', 'provider')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at   TEXT
);

INSERT INTO app_user_new (id, email, email_normalised, display_name, password_hash, role, status, created_at, updated_at, last_login_at)
  SELECT id, email, email_normalised, display_name, password_hash, role, status, created_at, updated_at, last_login_at
    FROM app_user;

DROP TABLE app_user;
ALTER TABLE app_user_new RENAME TO app_user;

-- Who asked to look after a listing, and what happened to the request.
--
-- `matches_contact` is filled in at submission: did the claimant's email or phone
-- line up with a contact point already on the listing? It is the weakest useful
-- evidence, but it is recorded so a reviewer can see at a glance whether the
-- claim corroborates itself.
--
-- `user_id` stays null until the claim is granted. There is no public
-- registration on this platform, so a new owner is created by the operator who
-- approves the claim, and before that happens there is no account to point at.
--
-- `access_token_hash` is HMAC'd with the session secret, never the token itself,
-- and only appears for claims made without signing in, exactly as marketplace
-- request tokens work: it lets the claimant withdraw their own request without
-- handing the platform a second copy of a secret.
CREATE TABLE business_claim (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  business_id     TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES app_user(id) ON DELETE SET NULL,

  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','granted','withdrawn','rejected','revoked')),

  claimed_as      TEXT NOT NULL,
  relation        TEXT NOT NULL,
  contact_email   TEXT,
  contact_phone   TEXT,
  evidence        TEXT,
  matches_contact INTEGER NOT NULL DEFAULT 0 CHECK (matches_contact IN (0, 1)),

  access_token_hash TEXT,

  reviewer_id     TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  reason          TEXT,
  decided_at      TEXT,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_business_claim_business ON business_claim(business_id, status);
CREATE INDEX idx_business_claim_user ON business_claim(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_business_claim_status ON business_claim(status, created_at);