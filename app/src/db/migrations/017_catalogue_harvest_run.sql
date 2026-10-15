-- 017: catalogue harvest runs
--
-- Phase 3. Phase 2 made a single record accountable: `catalogue.intake` writes
-- the business, its `record_provenance` row and its intake event in one
-- transaction, so a record that arrived one at a time can always say where it
-- came from and who took it in. Populating a whole directory from a real source,
-- though, means a file with hundreds of rows, and until now that path recorded
-- nothing: the CSV importer wrote listings directly, a source named in a column
-- landed in the legacy free-text `business.source_id`, and no provenance row
-- existed for any of it.
--
-- This migration adds the missing unit: a run. One row per ingestion of a
-- source's file, carrying the file's identity and a count of what the run did,
-- so that "where did these four hundred records come from" has one answer rather
-- than four hundred. `record_provenance.run_id` then ties each record back to
-- the run that produced it.
--
-- Two properties are deliberate.
--
--  1. A run is never deleted, and neither is a provenance row. The whole point
--     of the table is to answer a question about a past ingestion, and a record
--     of past ingestions that can be tidied away answers nothing. A run that is
--     no longer wanted is described in `notes`, not removed.
--
--  2. `status` is a small closed set with a `running` member, because a run that
--     began and never finished is a fact worth keeping: it is the only way an
--     operator can tell "the import failed halfway" apart from "the file was
--     never handed over".
--
-- No down migration: see src/db/migrator.js. A reset rebuilds from the seeds.

-- ---------------------------------------------------------------------------
-- catalogue_import_run
-- ---------------------------------------------------------------------------
--
-- One ingestion of one source's file.
--
-- The counts are stored rather than recomputed from the records, because the
-- counts describe what the *run* did (how many rows it skipped as duplicates,
-- how many it could not resolve) and that is not a property of any record that
-- survived. A run that created nothing and failed every row is the most
-- important run to be able to see, and it leaves no records behind to count.
CREATE TABLE catalogue_import_run (
  id             TEXT PRIMARY KEY,

  -- The source the file was imported under. RESTRICT rather than CASCADE, for
  -- the same reason provenance uses it: a source with a recorded run is a source
  -- somebody has to retire, never delete, so the history keeps its answer.
  source_id      TEXT NOT NULL REFERENCES catalogue_source(id) ON DELETE RESTRICT,

  -- The operator's name for this batch, when they gave one. Nullable because a
  -- one-off file has no batch, and a required value would be filled in with
  -- something meaningless.
  batch_ref      TEXT,

  -- What was ingested. The file name is for a person reading the list; the hash
  -- is how the platform recognises the same file handed over twice, which is the
  -- replay an operator actually does (fix one row, import again). Neither is
  -- needed to re-run anything, so a run recorded from stdin simply has no name.
  filename       TEXT,
  content_sha256 TEXT,

  actor_id       TEXT REFERENCES app_user(id) ON DELETE SET NULL,

  -- `running` until the importer records an outcome. An unexpected failure marks
  -- the run `failed` rather than leaving it running forever, so the two states
  -- mean "still going" and "went wrong" instead of overlapping.
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed')),

  total          INTEGER NOT NULL DEFAULT 0,
  created_count  INTEGER NOT NULL DEFAULT 0,
  updated_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,

  notes          TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT
);

-- The two questions asked of the table: "what has this source been fed" and
-- "what happened most recently". Both are a source plus a time ordering.
CREATE INDEX idx_catalogue_import_run_source
  ON catalogue_import_run(source_id, started_at DESC);
CREATE INDEX idx_catalogue_import_run_started
  ON catalogue_import_run(started_at DESC);

-- ---------------------------------------------------------------------------
-- record_provenance: the run that produced each row
-- ---------------------------------------------------------------------------
--
-- Nullable and SET NULL on delete, because provenance predates runs: every row
-- written before this migration has no run, and a run that is somehow removed
-- must not take the provenance row with it. A record's origin is more important
-- than the batch it arrived in.
ALTER TABLE record_provenance
  ADD COLUMN run_id TEXT REFERENCES catalogue_import_run(id) ON DELETE SET NULL;

CREATE INDEX idx_provenance_run
  ON record_provenance(run_id) WHERE run_id IS NOT NULL;
