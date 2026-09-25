-- 004: search
-- The full-text index that the public search experience reads from.
--
-- Design note: search is an index over supply, not a table of its own. Every
-- searchable thing in the platform (a business, a service, a product, a
-- category, a skill, a place) becomes one row in `search_document`, and the FTS5
-- index stores the text of those rows keyed by the document's rowid.
--
-- Splitting "what is searchable" (search_document) from "the text of it"
-- (search_index) is what lets us reindex text, change tokenisation, or add a
-- second index for a different language profile without rewriting a single
-- business row.

CREATE TABLE search_document (
  -- Explicit integer id so the FTS rowid can be pinned to it. AUTOINCREMENT is
  -- deliberate: a reused rowid would otherwise let a stale FTS entry be
  -- resurrected by a later document.
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stable natural key, '<source_type>:<source_id>'. The uniqueness of this is
  -- what makes indexing idempotent.
  doc_key      TEXT NOT NULL UNIQUE,

  source_type  TEXT NOT NULL CHECK (source_type IN (
                  'business','service','product','category','skill','place'
                )),
  source_id    TEXT NOT NULL,

  title        TEXT NOT NULL,
  -- The canonical path this result should link to, e.g. /business/abc-123.
  path         TEXT NOT NULL,
  -- Where it is. Denormalised so a location filter is a single indexed
  -- comparison rather than a join through business_location. `location_path_ids`
  -- carries the materialised path of that location ("district/city/ward"), so
  -- "everywhere inside Wakiso" is a prefix match on this column and does not
  -- require resolving the district's descendants per result.
  location_id  TEXT REFERENCES location(id) ON DELETE CASCADE,
  location_path_ids TEXT,
  category_id  TEXT REFERENCES category(id) ON DELETE SET NULL,
  -- JSON array of skill ids, kept denormalised for the same reason and because
  -- the skill filter is a containment test, not a join.
  skill_ids    TEXT NOT NULL DEFAULT '[]',

  -- Ranking inputs computed at index time so that a query can order by
  -- relevance plus trust without a second pass over the supply tables.
  trust_weight REAL NOT NULL DEFAULT 0,
  -- Denormalised breadcrumb ("Nakawa / Kampala / Wakiso District") for display
  -- without a recursive lookup.
  location_path TEXT,
  -- Compact text shown under the title in results.
  summary      TEXT,

  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  indexed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_search_document_source ON search_document(source_type, source_id);
CREATE INDEX idx_search_document_location ON search_document(location_id);
CREATE INDEX idx_search_document_category ON search_document(category_id);
CREATE INDEX idx_search_document_active ON search_document(is_active, source_type);
-- FTS5. `name` is weighted above `body` so that a match on a business name
-- outranks a match buried in a description.
--
-- unicode61 with remove_diacritics 2 handles the accented and apostrophised
-- spellings that appear in Ugandan business names and product listings
-- ("Nabugabo's", "Café") without a custom tokenizer.
--
-- This is a contentless-external-free, ordinary FTS5 table: rows are inserted
-- with an explicit rowid equal to search_document.id, and the delete command
-- carries the original values. The repository layer is the only writer, so the
-- index cannot drift.
CREATE VIRTUAL TABLE search_index USING fts5(
  name,
  body,
  keywords,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Search sessions. Not a behavioural profile: this table exists so that the
-- result page can be rendered and so that pagination is stable, and it is
-- discarded with the raw query retention window.
CREATE TABLE search_session (
  id                 TEXT PRIMARY KEY,
  -- Day-bucketed pseudonymous actor. Never a user id and never an IP: see
  -- src/core/privacy.js for why the salt rotates.
  actor_bucket       TEXT NOT NULL,
  coverage_level     TEXT,
  location_id        TEXT REFERENCES location(id) ON DELETE SET NULL,
  -- Which surface produced the search. Lets the demand engine weight or even
  -- exclude internal traffic (admin search) from public demand.
  surface            TEXT NOT NULL DEFAULT 'web'
                       CHECK (surface IN ('web','api','admin','import','system')),
  -- Filters applied, as a JSON object, so the result page can be reproduced.
  filters_json       TEXT NOT NULL DEFAULT '{}',
  result_count       INTEGER NOT NULL DEFAULT 0,
  in_area_count      INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_interaction_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_search_session_bucket ON search_session(actor_bucket, created_at DESC);
CREATE INDEX idx_search_session_created ON search_session(created_at DESC);
