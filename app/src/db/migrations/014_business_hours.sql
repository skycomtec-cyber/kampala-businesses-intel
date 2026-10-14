-- 014: opening hours
--
-- When a business is open, as a recurring weekly schedule. One row per weekday,
-- so a day is either closed or has one opening and one closing time. Split
-- shifts (a shop that closes for lunch) are not expressible here on purpose:
-- adding a second interval per day is a much larger model, and nothing in the
-- data this platform holds has needed it yet.
--
-- The day is an ISO weekday, 1 (Monday) to 7 (Sunday), because the number is
-- written down and read back and "0 is Sunday" is a fact only its author
-- remembers. Times are `HH:MM` on a 24-hour clock in East Africa Time, which is
-- a constant here rather than a column: Uganda is UTC+3 with no daylight
-- saving, and the platform serves Uganda.
--
-- Three things are enforced by the schema so no writer can invent a state the
-- rule in src/core/hours.js has never heard of:
--
--   1. A closed day has no times, and an open day has both. A closed row with
--      times is a day somebody meant to be open, and an open row without times
--      is a day nobody can act on.
--   2. Opening and closing times differ. A "00:00 to 00:00" day is either never
--      or always, and the two are opposites.
--   3. The time columns have the `HH:MM` shape, so a hand-written import cannot
--      store "9am" where the reader expects a clock.
--
-- `closes` earlier than `opens` is allowed and is not a mistake: it is a night
-- shift, and the rule layer reads it as running past midnight.

CREATE TABLE business_hours (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,

  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  is_closed   INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),

  opens       TEXT,
  closes      TEXT,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (business_id, weekday),

  CHECK (
    (is_closed = 1 AND opens IS NULL AND closes IS NULL)
    OR (is_closed = 0 AND opens IS NOT NULL AND closes IS NOT NULL)
  ),
  CHECK (opens IS NULL OR opens GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (closes IS NULL OR closes GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (opens IS NULL OR closes IS NULL OR opens <> closes)
);

CREATE INDEX idx_business_hours_business ON business_hours(business_id, weekday);
