-- 015: business reviews and ratings
--
-- What customers say about a business, one row per review. This is the first
-- table in the platform whose content is written by the public rather than by an
-- operator, so the model is built around moderation from the start rather than
-- bolted on.
--
-- Three decisions are worth writing down:
--
--   1. A review is never published on arrival. `status` starts at `pending`, and
--      only a recorded decision moves it to `published` or `rejected`. The public
--      profile reads only `published`, so nothing a stranger types is visible
--      until somebody has looked at it — the same rule the listings themselves
--      follow, applied to the words about them.
--
--   2. `rating` is a small integer in the schema, not a float. A five-point scale
--      is an ordinal judgement, and storing 4 as 4.0 invites an average to be
--      reported as if it described a measurement. The average is computed at read
--      time in src/core/reviews.js and never stored, for the same reason an
--      open/closed badge is derived: a stored average is one a deleted review can
--      leave wrong forever.
--
--   3. `author_email` is private. It is collected so a moderator can follow up
--      about a review that looks like spam, and it is never returned by any
--      route. The public author is `author_name`, which is a display name and
--      nothing more. The column exists rather than being dropped because the one
--      thing worse than holding a private address is holding it somewhere the
--      public read cannot reach but an operator still can.
--
-- `business_review` is deliberately not called `review`: a `review_event` table
-- already exists for the listing review workflow, and two things called "review"
-- in one schema is a mistake that only shows up when somebody queries the wrong
-- one.

CREATE TABLE business_review (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,

  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        TEXT,
  body         TEXT,

  author_name  TEXT NOT NULL,
  author_email TEXT,

  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'published', 'rejected')),
  source       TEXT NOT NULL DEFAULT 'web'
               CHECK (source IN ('web', 'api')),

  -- Who decided, why, and when. Null until a moderator acts, exactly like a
  -- listing's review trail: the only way to change a status is to record a
  -- decision, and the reason is the part of it anybody reads later.
  reviewer_id       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  moderation_reason TEXT,
  moderated_at      TEXT,

  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The public profile's read: one business's published reviews, newest first.
CREATE INDEX idx_business_review_business
  ON business_review(business_id, status, created_at);

-- The moderation queue's read: everything awaiting a decision, oldest first.
CREATE INDEX idx_business_review_status
  ON business_review(status, created_at);
