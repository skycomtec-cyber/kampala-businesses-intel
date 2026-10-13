-- 012: second life electronics
--
-- Second Life Electronics is the platform's first specialised vertical, and a
-- vertical is not a category: choosing "Second Life Electronics" from a menu
-- already browses the six subcategories underneath it (device-repair,
-- device-refurbishment, parts-recovery, resale-and-trading, recycling-and-e-waste
-- and data-and-storage-services). What the taxonomy could not express is what
-- actually happens to a device after it is handed over, which is the operation
-- the whole vertical exists to describe.
--
-- So this migration adds the device intake: one row per device a business takes
-- in, walked through a fixed lifecycle from received to closed, ending in a
-- recorded outcome. It is deliberately not a second copy of the marketplace. The
-- marketplace is about demand ("somebody is looking for a repair"), and an
-- intake is about a physical thing that exists, is worked on, and leaves in a
-- named state. Those are different facts with different owners, and collapsing
-- them would lose the one the vertical was built for.
--
-- Two rules are encoded in the schema rather than left to the application:
--
--   1. A closed intake always names its outcome, and an intake that is not closed
--      never does. A closed row with a null outcome is a device that vanished, and
--      a non-closed row with an outcome is a job that was finished twice.
--
--   2. `stage` and `outcome` are constrained by CHECK, not by convention. The
--      values are declared in src/core/secondLife.js; the constraint is what keeps
--      a hand-written import from inventing a seventh activity the rest of the
--      platform has never heard of.
--
-- The event table is the intake's own history, written on every stage move. It is
-- what makes "how long does a refurbishment take" answerable from the record
-- rather than estimated, the same way request_status_event does for the
-- marketplace.

CREATE TABLE device_intake (
  id                    TEXT PRIMARY KEY,
  -- Human-facing reference, e.g. SL-2026-00042. Quoted over the counter and
  -- typed back in, so it is unique and short rather than a UUID.
  reference             TEXT NOT NULL UNIQUE,

  -- The operator that holds the device. An intake is a business record, so it is
  -- owned by a business the same way a listing is.
  business_id           TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  -- The taxonomy node the work falls under, resolved from the activity. Nullable
  -- because an operator may record an intake before deciding which subcategory it
  -- belongs to, and a missing category must not block the intake.
  category_id           TEXT REFERENCES category(id) ON DELETE SET NULL,

  -- Which of the vertical's activities this is. The single field the whole
  -- vertical is organised around.
  activity              TEXT NOT NULL
                        CHECK (activity IN ('repair','refurbishment','parts_recovery','resale','recycling','data_services')),

  -- What the thing is, kept as a closed list so the summary can be grouped
  -- without a free-text cleanup pass.
  device_type           TEXT NOT NULL
                        CHECK (device_type IN ('smartphone','laptop','desktop','tablet','television','monitor','printer','appliance','battery','component','other')),
  -- The condition as received. Deliberately not the product `condition` list:
  -- a product is a thing for sale and a received device is a thing needing work,
  -- so "water damaged" belongs here and "refurbished" belongs there.
  received_condition    TEXT NOT NULL
                        CHECK (received_condition IN ('working','faulty','for_parts','water_damaged','physical_damage','unknown')),

  make                  TEXT,
  model                 TEXT,
  quantity              INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),

  -- The intake lifecycle. `closed` is the only terminal state.
  stage                 TEXT NOT NULL DEFAULT 'received'
                        CHECK (stage IN ('received','diagnosed','in_progress','ready','closed')),
  -- What happened, once and only once the job closed.
  outcome               TEXT
                        CHECK (outcome IS NULL OR outcome IN ('repaired','refurbished','parts_recovered','resold','recycled','returned','scrapped')),

  -- The privacy rule of this vertical, made explicit: a device holding somebody's
  -- data must be wiped before it leaves the business. Requesting the wipe and
  -- recording that it happened are separate facts, because the gap between them is
  -- exactly the risk. core/secondLife.js refuses to close certain outcomes while a
  -- requested wipe is outstanding.
  data_wipe_requested   INTEGER NOT NULL DEFAULT 0 CHECK (data_wipe_requested IN (0, 1)),
  data_wipe_completed   INTEGER NOT NULL DEFAULT 0 CHECK (data_wipe_completed IN (0, 1)),

  -- How the owner is referred to on this record. Deliberately free text and
  -- deliberately not a user id: the counter staff need to recognise the row, and
  -- the platform does not need to know who the customer is.
  owner_ref             TEXT,
  notes                 TEXT,

  closed_at             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- The two rules from the header, enforced here so no writer can break them.
  CHECK ((stage = 'closed') = (outcome IS NOT NULL)),
  CHECK (data_wipe_completed = 0 OR data_wipe_requested = 1)
);

CREATE INDEX idx_device_intake_business ON device_intake(business_id, created_at);
CREATE INDEX idx_device_intake_stage    ON device_intake(stage);
CREATE INDEX idx_device_intake_outcome  ON device_intake(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_device_intake_activity ON device_intake(activity, stage);

-- Append-only. Every stage move and every field the operator changed writes a
-- row here, so the intake's own record is the source of truth for its history.
CREATE TABLE device_intake_event (
  id          TEXT PRIMARY KEY,
  intake_id   TEXT NOT NULL REFERENCES device_intake(id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  outcome     TEXT,
  actor_id    TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_device_intake_event ON device_intake_event(intake_id, created_at);
