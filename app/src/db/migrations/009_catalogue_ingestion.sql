-- 009: catalogue ingestion and review pipeline
--
-- Phase 2. Everything before this phase could say where a listing came from
-- (`business.source_id`, a free-text string) and could say whether it had been
-- verified, but it could not say who checked it, what they checked, why they
-- decided what they decided, or which source was trusted enough to be worth
-- reading. This migration adds the three tables that answer those questions and
-- replaces the review vocabulary on `business` with the pipeline the
-- specification defines.
--
-- The single most important property enforced here is that `approved` is the only
-- review state the public may see. Before this migration, any active business
-- that had not been *rejected* was public, which meant a spreadsheet row nobody
-- had read was indistinguishable from a listing this platform stands behind. The
-- data mapping below fixes that: every record that used to be `verified` becomes
-- `approved` and stays public, and every record that was merely unclaimed becomes
-- `pending_review` and therefore leaves public view.
--
-- No down migration: see src/db/migrator.js. A reset rebuilds from the seeds.
--
-- migrate:table_rebuild
-- The `business` table is recreated below, because SQLite cannot alter a CHECK
-- constraint. See the note at that step for why this line is here.

-- ---------------------------------------------------------------------------
-- catalogue_source
-- ---------------------------------------------------------------------------
--
-- The registry of places records come from. This is what makes "KampalaBiz
-- Manual Import" something the platform knows about rather than a string somebody
-- typed, and it is what lets a reviewer ask "who vouched for this row" before
-- deciding whether to publish it.
CREATE TABLE catalogue_source (
  id          TEXT PRIMARY KEY,

  -- Stable, typeable identifier used in URLs, imports and the seed file. Separate
  -- from the name because sources get renamed ("KampalaBiz" becomes "KampalaBiz
  -- Kampala") and every reference to one has to survive that.
  key         TEXT NOT NULL UNIQUE,

  name        TEXT NOT NULL,

  -- How the records arrive. Decides which import path handles them and, together
  -- with the trust level, what may be done with a record before a human has seen
  -- it.
  type        TEXT NOT NULL
              CHECK (type IN ('manual','csv','api','partner','survey','web')),

  -- How far this source can be trusted. A controlled source is one an authorised
  -- operator vouches for personally, so its records may enter the review queue
  -- with their provenance already attached. A community or unverified source
  -- carries less weight, and a reviewer looking at one has to check the claim
  -- rather than the typing of it.
  trust_level TEXT NOT NULL DEFAULT 'unverified'
              CHECK (trust_level IN ('controlled','community','unverified')),

  -- Who maintains the source and where its data lives. Plain text rather than a
  -- user reference, because a source outlives the accounts of whoever registered
  -- it and losing that would make an old import un-explainable.
  owner       TEXT,
  uri         TEXT,
  licence     TEXT,
  notes       TEXT,

  -- A retired source stops being offered for new ingestions but keeps its
  -- records and its provenance, because "where did this come from" must still
  -- have an answer years later.
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ingestions offer the sources that can be used now, grouped by kind.
CREATE INDEX idx_catalogue_source_active ON catalogue_source(is_active, type);
CREATE INDEX idx_catalogue_source_trust ON catalogue_source(trust_level);

-- ---------------------------------------------------------------------------
-- business: the review pipeline
-- ---------------------------------------------------------------------------
--
-- The procedure, and why each step exists:
--
--   1. CREATE the replacement under a temporary name. Nothing references it yet,
--      so the rename at the end cannot rewrite any other table's foreign key.
--   2. COPY across, mapping the old vocabulary onto the pipeline.
--   3. DROP the old table. This is the step that requires foreign key
--      enforcement to be off, because SQLite implements DROP TABLE as an implicit
--      DELETE FROM and every child row (business_location, contact_point, service,
--      product, business_skill, request_offer, interaction_event) cascades with
--      it. That is why the migration declares `-- migrate:table_rebuild` above:
--      the runner suspends enforcement around this transaction and then runs
--      `PRAGMA foreign_key_check` inside it, so a rebuild that damaged a
--      reference rolls back instead of being applied.
--   4. RENAME the replacement to `business`. Every child table's foreign key
--      clause still says `REFERENCES business(id)` and now resolves again, which
--      is why no child table is touched at all.
CREATE TABLE business_catalogue (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  description        TEXT,
  category_id        TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,

  -- Primary location is denormalised onto the business because almost every read
  -- path needs it, and joining through a separate table for that would be the
  -- single most common join in the platform.
  primary_location_id TEXT NOT NULL REFERENCES location(id) ON DELETE RESTRICT,

  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','active','suspended','closed')),

  -- The review pipeline. Operational status and review state are separate columns
  -- on purpose: `approved` says "we stand behind these facts", `active` says "we
  -- are publishing this listing today". A business can be approved and suspended,
  -- and the public then sees neither.
  --
  -- The default is pending_review rather than imported, because a record created
  -- by a person in the admin UI is not raw intake: it is something somebody
  -- decided to write down. It still has not been checked, so it enters the queue.
  verification_state TEXT NOT NULL DEFAULT 'pending_review'
                     CHECK (verification_state IN (
                       'imported','pending_review','under_review',
                       'verified','approved','rejected','archived'
                     )),

  capability_level   TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (capability_level IN ('unverified','claimed','documented','operating','established')),

  website            TEXT,
  founded_year       INTEGER,

  -- Where this record came from.
  --
  -- `source_id` is the pre-phase-2 free-text column, kept so records written by
  -- the CSV importer keep working unchanged. `catalogue_source_id` is the
  -- controlled reference this phase adds, and is what the review pipeline reads.
  -- Both are denormalised onto the business deliberately: "which source is this?"
  -- appears on every queue row and every record page, and a join to answer it
  -- would be the most frequent join in the admin surface. The full history of a
  -- record's origins lives in record_provenance, which this column does not
  -- replace.
  source_id          TEXT,
  catalogue_source_id TEXT REFERENCES catalogue_source(id) ON DELETE SET NULL,

  is_open_source     INTEGER CHECK (is_open_source IN (0, 1)),

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at        TEXT,

  -- When approval happened, kept apart from verified_at because the two are
  -- separate claims made on separate days: the facts were checked on one, and the
  -- editorial decision to publish on the other.
  approved_at        TEXT,

  -- Which reviewer has taken the record, and when. This is what makes
  -- `under_review` more than a label: two reviewers have to be able to see that a
  -- colleague already has a record, which is the difference between a queue and a
  -- shared scratchpad.
  review_owner_id    TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  review_claimed_at  TEXT,

  last_confirmed_at  TEXT
);

-- The old review states mapped onto the pipeline:
--
--   unverified -> pending_review  never claimed, so it belongs in the queue
--   claimed    -> pending_review  a claim was made but nothing was checked, which
--                                    is exactly what the queue is for
--   verified   -> approved        this platform already published these as true,
--                                    and phase 2 must not withdraw listings that
--                                    were public yesterday. The pipeline order is
--                                    preserved in review_event below and
--                                    approved_at is seeded from updated_at so the
--                                    decision still carries a date.
--   pending_review, rejected -> unchanged
--
-- No other value can occur: the old CHECK forbade it.
INSERT INTO business_catalogue (
  id, name, slug, description, category_id, primary_location_id, status,
  verification_state, capability_level, website, founded_year, source_id,
  is_open_source, created_at, updated_at, verified_at, approved_at,
  last_confirmed_at
)
SELECT
  id, name, slug, description, category_id, primary_location_id, status,
  CASE verification_state
    WHEN 'unverified' THEN 'pending_review'
    WHEN 'claimed'    THEN 'pending_review'
    WHEN 'verified'   THEN 'approved'
    ELSE verification_state
  END,
  capability_level, website, founded_year, source_id,
  is_open_source, created_at, updated_at, verified_at,
  CASE WHEN verification_state = 'verified' THEN updated_at ELSE NULL END,
  last_confirmed_at
FROM business;

DROP TABLE business;
ALTER TABLE business_catalogue RENAME TO business;

-- The indexes from 003 are recreated by hand, because dropping a table drops the
-- indexes declared on it. These definitions are identical to 003's.
CREATE INDEX idx_business_category ON business(category_id);
CREATE INDEX idx_business_location ON business(primary_location_id);
CREATE INDEX idx_business_name ON business(name);

-- The review queue. (state, updated_at) rather than (state) alone, because the
-- queue is read as "oldest waiting first" and an index without the sort column
-- would make SQLite sort the whole table for every page of it.
CREATE INDEX idx_business_review ON business(verification_state, updated_at ASC);
-- Public listings always ask for this state and this status together, so the pair
-- is itself the index.
CREATE INDEX idx_business_published ON business(verification_state, status, name);
CREATE INDEX idx_business_catalogue_source ON business(catalogue_source_id)
  WHERE catalogue_source_id IS NOT NULL;
-- Who is working on what. Partial, because it is only ever asked for records
-- somebody has claimed, and that is a small fraction of the table.
CREATE INDEX idx_business_review_owner ON business(review_owner_id)
  WHERE review_owner_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- record_provenance
-- ---------------------------------------------------------------------------
--
-- One row per place a fact about a business came from. A record may have several:
-- the KampalaBiz manual import is where the operator found it, a survey is where
-- the details were confirmed, the owner is where the phone number came from.
-- Collapsing that into one `source_id` string is exactly what made it impossible
-- to answer "who told us this?" for a record more than one source had touched.
CREATE TABLE record_provenance (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,

  -- Restricted, not cascading: deleting a source must not silently delete the
  -- evidence that a record was ever sourced from it. Sources are retired
  -- (is_active = 0) instead of deleted, for the same reason.
  source_id   TEXT NOT NULL REFERENCES catalogue_source(id) ON DELETE RESTRICT,

  -- The identifier the source itself used, if it used one. With source_id this is
  -- the idempotency key for ingestion: replaying a source must update the existing
  -- provenance row rather than stack up duplicates, and the partial unique index
  -- below enforces that at the storage layer instead of trusting every caller to
  -- check first.
  external_ref TEXT,

  -- Which run produced this row: an import batch reference, or the operator's
  -- session when a record was entered by hand.
  batch_ref   TEXT,

  -- How the claim was obtained. A URL, a document name, "walked past the shop".
  -- This is the field a reviewer reads to decide whether a claim is checkable, so
  -- it is stored with the record rather than in a note that later gets tidied away.
  evidence    TEXT,
  notes       TEXT,

  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Who on this platform did the importing. Null means the system did, for example
  -- a scheduled import with no operator attached.
  imported_by TEXT REFERENCES app_user(id) ON DELETE SET NULL,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_provenance_business ON record_provenance(business_id, imported_at DESC);
CREATE INDEX idx_provenance_source ON record_provenance(source_id, imported_at DESC);
CREATE INDEX idx_provenance_actor ON record_provenance(imported_by) WHERE imported_by IS NOT NULL;
CREATE UNIQUE INDEX idx_provenance_identity
  ON record_provenance(source_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- review_event
-- ---------------------------------------------------------------------------
--
-- The record of every movement a listing made through the pipeline, including the
-- one that published it. The generic audit_log records that something happened;
-- this table records the journey, in pipeline terms, in order, and is the thing
-- the specification asks for when it says an approved listing must be traceable
-- to the decision that approved it. That is a question about one entity over
-- time, not about a log stream, and it has to stay answerable after an operator
-- has worked through several hundred other records.
CREATE TABLE review_event (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,

  -- Null for intake: a record that arrives from a source has no prior state.
  from_state  TEXT
              CHECK (from_state IS NULL OR from_state IN (
                'imported','pending_review','under_review',
                'verified','approved','rejected','archived'
              )),
  to_state    TEXT NOT NULL
              CHECK (to_state IN (
                'imported','pending_review','under_review',
                'verified','approved','rejected','archived'
              )),

  -- The decision, not the result: "approve" is something a person did, whereas
  -- "approved" is only where it left them. `import` is the odd one out: it names
  -- the intake event a source produced, and it is not performable on a record that
  -- already exists, because there is no way back to intake.
  action      TEXT NOT NULL
              CHECK (action IN (
                'import','claim','submit','verify','approve','unapprove',
                'reject','archive','reopen'
              )),

  actor_id    TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role  TEXT,

  -- Why. Nullable because not every event is a decision, but a rejection or an
  -- approval with no stated basis cannot be argued with later, and a directory
  -- nobody can argue with is a directory nobody can correct.
  reason      TEXT,

  -- The source that triggered this event, when the event was intake rather than a
  -- human decision. Null for reviewer decisions.
  source_id   TEXT REFERENCES catalogue_source(id) ON DELETE SET NULL,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ordered oldest-first, because the question is always "what has happened to this
-- record, in order".
CREATE INDEX idx_review_event_business ON review_event(business_id, created_at ASC);
CREATE INDEX idx_review_event_actor ON review_event(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;
CREATE INDEX idx_review_event_state ON review_event(to_state, created_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- The review journey for records that already existed.
--
-- A record that was `verified` before this migration went through a pipeline the
-- platform did not record: somebody looked at it and decided it was true, and it
-- was published. Both steps are reconstructed as explicit events so that every
-- approved record in the database has a decision behind it, which is the
-- invariant this phase introduces. The timestamps are the record's own updated_at
-- rather than the moment this migration runs, because a fabricated "now" would
-- claim the decision was taken today, and reconstructed history that lies about
-- when it happened is worse than no history.
--
-- The intake step is deliberately not invented: when the original text arrived is
-- not something this migration can know, and a plausible guess is a fabricated
-- fact about a real business.
INSERT INTO review_event (
  id, business_id, from_state, to_state, action, actor_role, reason, created_at
)
SELECT
  're_' || lower(hex(randomblob(16))),
  id,
  NULL,
  'verified',
  'verify',
  NULL,
  'Reconstructed during migration 009: this record was marked verified before the review pipeline existed.',
  updated_at
FROM business
WHERE verification_state = 'approved';

INSERT INTO review_event (
  id, business_id, from_state, to_state, action, actor_role, reason, created_at
)
SELECT
  're_' || lower(hex(randomblob(16))),
  id,
  'verified',
  'approved',
  'approve',
  NULL,
  'Reconstructed during migration 009: this record was publicly listed before the review pipeline existed.',
  updated_at
FROM business
WHERE verification_state = 'approved';

-- Every record that existed before the pipeline is, by definition, a record
-- nobody sourced through a registered source. Leaving those with no provenance row
-- would make "every catalogue record carries provenance" false from the moment
-- this migration finished, so the legacy source is registered here and the
-- existing records are attached to it. An operator-created record and a record
-- from an unregistered spreadsheet are both, described honestly, "entered into
-- this platform directly", and that is the claim being made about them.
INSERT INTO catalogue_source (id, key, name, type, trust_level, notes, is_active)
VALUES (
  'src_legacy_directory',
  'legacy-directory',
  'Direct entry (pre-pipeline)',
  'manual',
  'unverified',
  'Records entered into the platform before the catalogue pipeline existed. No ' ||
  'source outside this platform was ever recorded for them, which is why they are ' ||
  'unverified and why working through the review queue is worth the time.',
  1
);

INSERT INTO record_provenance (
  id, business_id, source_id, evidence, notes, imported_at, created_at
)
SELECT
  'pv_' || lower(hex(randomblob(16))),
  id,
  'src_legacy_directory',
  'Entered directly into the platform.',
  'Backfilled by migration 009: no external source was recorded for this record.',
  created_at,
  created_at
FROM business;
