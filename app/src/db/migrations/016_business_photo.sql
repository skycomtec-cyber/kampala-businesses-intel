-- Business photographs.
--
-- A gallery is the part of a listing a visitor trusts before they read a word of
-- it, so a photo is treated exactly like a review: anonymous input is not public
-- until a moderator says so, and the row cannot be moved into or out of the
-- public view by any path other than a recorded decision.
--
-- Three things about the shape are deliberate.
--
--  1. The image bytes are NOT in this table. `storage_key` names a file under the
--     media directory and the row holds only the metadata. A photograph is the
--     largest thing this platform stores, and SQLite is a poor place for a
--     megabyte of JPEG: every backup would carry it, every query over the table
--     would walk past it, and the database file would stop being something a
--     person can copy in a second. The database and the media directory are
--     therefore one unit — a backup of one without the other restores rows that
--     point at nothing — which is why the media directory lives inside the data
--     directory by default.
--
--  2. `mime_type` is a closed set. Only JPEG, PNG and WebP are accepted, and the
--     value is taken from the file's magic bytes, never from what the caller
--     claimed. A browser will render whatever an <img> points at, so letting the
--     content type be caller-controlled would turn this table into a way to serve
--     a script from the platform's own origin.
--
--  3. `position` exists because a gallery is ordered and the owner is the one who
--     knows which picture should be first. It is an integer rather than a stored
--     index so reordering one photo never has to rewrite its neighbours.
--
-- `business_photo` rather than `photo`: the catalogue already has an image notion
-- for imports, and a bare `photo` would collide with it the first time somebody
-- queried the wrong one.

CREATE TABLE business_photo (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,

  -- File name relative to the media directory, e.g. "<id>.webp". Never returned
  -- to a public caller: the content route is addressed by photo id, so the path
  -- on disk is an implementation detail the api does not leak.
  storage_key  TEXT NOT NULL,
  mime_type    TEXT NOT NULL
               CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),

  caption      TEXT,
  alt_text     TEXT,
  position     INTEGER NOT NULL DEFAULT 0,

  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'published', 'rejected')),
  source       TEXT NOT NULL DEFAULT 'provider'
               CHECK (source IN ('provider', 'admin', 'api', 'import')),

  uploaded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  reviewer_id       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  moderation_reason TEXT,
  moderated_at      TEXT,

  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The public gallery: published photos of one business, in the owner's order.
CREATE INDEX idx_business_photo_public
  ON business_photo (business_id, status, position, created_at);

-- The moderation queue: pending first, oldest first.
CREATE INDEX idx_business_photo_status
  ON business_photo (status, created_at);
