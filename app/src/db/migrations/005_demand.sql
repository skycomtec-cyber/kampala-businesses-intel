-- 005: demand
-- What people asked for, expressed so that it is useful to the platform and
-- useless to anyone who wants to follow an individual around.
--
-- The privacy contract for this whole file:
--
--   * No IP address, no device id, no user agent, no precise timestamp on an
--     aggregate ever reaches a table. `src/core/privacy.js` decides what is
--     allowed to leave a request, and this schema only has columns for the
--     output of that function.
--   * `actor_bucket` is HMAC(day_salt, actor_seed) with a salt that rotates
--     daily. It counts distinct actors within a day and cannot link a person
--     across days. Over-counting across a day boundary is the safe direction.
--   * Raw query text is quarantined in `search_query_raw` with its own, shorter
--     retention window, because it is the only genuinely re-identifying column
--     in the platform. Everything the engine actually computes is derived from
--     tokens in `search_event`, which never contain the original string.
--   * Every aggregate that can be published carries `distinct_actors` so the
--     k-anonymity floor has something to check.

-- One row per search performed. This is the atomic unit of demand.
CREATE TABLE search_event (
  id                TEXT PRIMARY KEY,
  search_session_id TEXT REFERENCES search_session(id) ON DELETE SET NULL,

  actor_bucket      TEXT NOT NULL,
  -- UTC day, materialised so daily aggregation is an index range scan rather
  -- than a date() call on every row.
  day               TEXT NOT NULL,
  surface           TEXT NOT NULL DEFAULT 'web'
                      CHECK (surface IN ('web','api','admin','import','system')),

  -- Coverage location: the most specific level the search was scoped to. Null
  -- means the person did not constrain their search to a place, which is
  -- itself a meaningful distinction from "searched in Kampala".
  location_id       TEXT REFERENCES location(id) ON DELETE SET NULL,
  coverage_level    TEXT,
  category_id       TEXT REFERENCES category(id) ON DELETE SET NULL,

  -- Stable hash of the normalised query. Lets the engine recognise a repeated
  -- search without holding the text.
  query_hash        TEXT NOT NULL,
  -- JSON array of the demand tokens (see core/demand.js: tokenise minus stop
  -- words). This, not the raw string, is what every demand computation reads.
  tokens_json       TEXT NOT NULL DEFAULT '[]',
  -- JSON array of the adjacent demand bigrams and trigrams. "laptop repair" is
  -- a demand signal; "laptop" alone is dominated by product browsing.
  phrases_json      TEXT NOT NULL DEFAULT '[]',
  n_tokens          INTEGER NOT NULL DEFAULT 0,
  n_phrases         INTEGER NOT NULL DEFAULT 0,

  -- 0 to 1. How precisely the person stated their need: named product plus
  -- named place scores far above a generic browse. Used as a multiplier in
  -- core/intelligence.js, never as a filter.
  specificity       REAL NOT NULL DEFAULT 0,

  -- Result quality, from core/demand.js classifyResultQuality.
  total_results     INTEGER NOT NULL DEFAULT 0,
  in_area_results   INTEGER,
  result_quality    TEXT NOT NULL DEFAULT 'zero'
                      CHECK (result_quality IN ('zero','none_in_area','single','thin','healthy')),

  -- Raw retention bookkeeping. The row itself is deleted on this date; the
  -- derived aggregates in demand_signal_daily survive.
  expires_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_search_event_day ON search_event(day DESC);
CREATE INDEX idx_search_event_hash ON search_event(query_hash, day DESC);
CREATE INDEX idx_search_event_location ON search_event(location_id, day DESC);
CREATE INDEX idx_search_event_session ON search_event(search_session_id);
CREATE INDEX idx_search_event_expiry ON search_event(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_search_event_quality ON search_event(result_quality, day DESC);

-- Quarantine for the original query string.
--
-- Kept apart from search_event on purpose: this is the only table in the
-- platform that can identify a person, and isolating it means a query-text
-- retention job never has to touch, and therefore can never accidentally
-- preserve, the pseudonymised aggregate rows.
CREATE TABLE search_query_raw (
  id              TEXT PRIMARY KEY,
  search_event_id TEXT NOT NULL REFERENCES search_event(id) ON DELETE CASCADE,
  -- The salt used to derive actor_bucket for this event. Storing the salt
  -- alongside the text is what allows a k-anonymity audit to verify that a
  -- given aggregate really was computed over that many actors.
  salt            TEXT NOT NULL,
  raw_query       TEXT NOT NULL,
  normalised_query TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at      TEXT NOT NULL
);

CREATE INDEX idx_query_raw_expiry ON search_query_raw(expires_at);
CREATE INDEX idx_query_raw_event ON search_query_raw(search_event_id);

-- Daily aggregate: one row per (day, coverage location, phrase).
--
-- This is the table the gap engine reads. It is written by a rollup job, not by
-- the request path, so a slow or failed rollup degrades the lab's freshness but
-- can never slow down a search or lose a search.
CREATE TABLE demand_signal_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  day             TEXT NOT NULL,
  -- The signal unit. Stored as the phrase itself (e.g. 'laptop repair') so a
  -- gap report can be read by a human without a join, and duplicated in
  -- `term` as the single normalised token it is a substring of, so unigram
  -- rollups are a plain equality match.
  phrase          TEXT NOT NULL,
  term            TEXT NOT NULL,
  ngram_size      INTEGER NOT NULL CHECK (ngram_size BETWEEN 1 AND 3),

  location_id     TEXT REFERENCES location(id) ON DELETE CASCADE,
  coverage_level  TEXT,
  category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,

  searches        INTEGER NOT NULL DEFAULT 0,
  -- The privacy floor input. Every read of this table goes through
  -- core/privacy.js suppressIfBelowK, which refuses to return a row whose
  -- distinct_actors is under the configured k.
  distinct_actors INTEGER NOT NULL DEFAULT 0,

  zero_results    INTEGER NOT NULL DEFAULT 0,
  none_in_area    INTEGER NOT NULL DEFAULT 0,
  -- Sum of specificity over the searches, divided by `searches` at read time,
  -- because SQLite has no reliable weighted-average aggregate.
  specificity_sum REAL NOT NULL DEFAULT 0,
  -- Distinct result counts observed, for the median-ish read in the lab.
  total_results   INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (day, phrase, location_id, ngram_size)
);

CREATE INDEX idx_demand_signal_lookup ON demand_signal_daily(phrase, location_id, day DESC);
CREATE INDEX idx_demand_signal_location ON demand_signal_daily(location_id, day DESC);
CREATE INDEX idx_demand_signal_day ON demand_signal_daily(day DESC);
CREATE INDEX idx_demand_signal_term ON demand_signal_daily(term, day DESC);
CREATE INDEX idx_demand_signal_category ON demand_signal_daily(category_id, day DESC);

-- What people did after searching. The second half of the demand picture: a
-- search nobody clicks is a different signal from a search that leads to a
-- contact being made.
CREATE TABLE interaction_event (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN (
                  'search','result_click','business_view','profile_contact',
                  'request_created','request_offer','save','zero_result_search'
                )),
  actor_bucket    TEXT,
  day             TEXT NOT NULL,
  -- Links an interaction back to the search that produced it, which is what
  -- makes "this search led to nobody contacting a business" answerable.
  search_event_id TEXT REFERENCES search_event(id) ON DELETE SET NULL,
  business_id     TEXT REFERENCES business(id) ON DELETE SET NULL,
  location_id     TEXT REFERENCES location(id) ON DELETE SET NULL,
  -- Rank of the clicked result, for click-through analysis.
  result_rank     INTEGER,
  -- Non-identifying extras. The repository layer validates this against an
  -- allowlist of keys before it is written, so a new field cannot leak by
  -- default.
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at      TEXT
);

CREATE INDEX idx_interaction_day ON interaction_event(day DESC);
CREATE INDEX idx_interaction_search ON interaction_event(search_event_id);
CREATE INDEX idx_interaction_business ON interaction_event(business_id, day DESC);
CREATE INDEX idx_interaction_type ON interaction_event(type, day DESC);
CREATE INDEX idx_interaction_expiry ON interaction_event(expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Marketplace
-- The one part of demand that a person stated on purpose rather than by typing
-- a search. It is therefore the highest-quality demand signal the platform has
-- and is worth weighting accordingly in the gap engine.
-- ---------------------------------------------------------------------------

CREATE TABLE request (
  id              TEXT PRIMARY KEY,
  -- Human-facing reference, e.g. KMP-2026-00418. Stable and shareable so a
  -- provider and a requester can refer to the same request in a phone call.
  reference       TEXT NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,

  title           TEXT NOT NULL,
  description     TEXT,
  category_id     TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  location_id     TEXT NOT NULL REFERENCES location(id) ON DELETE RESTRICT,

  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','matched','in_progress','fulfilled','cancelled','expired')),
  urgency         TEXT NOT NULL DEFAULT 'normal'
                    CHECK (urgency IN ('low','normal','high','urgent')),

  -- Requests may be posted without an account. A logged-in requester is linked
  -- here; an anonymous one is not, and is identified only by its day-bucketed
  -- actor hash for the lifetime of the request.
  requester_user_id TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  requester_bucket TEXT,
  is_anonymous    INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),

  -- What the requester is willing to pay. Null is normal and must not be read
  -- as zero.
  budget_min      REAL,
  budget_max      REAL,
  currency        TEXT NOT NULL DEFAULT 'UGX',

  -- A wanted item that is satisfied by resupplying a used product is a Second
  -- Life Electronics supply signal, which is why this flag is first-class.
  accepts_used    INTEGER NOT NULL DEFAULT 0 CHECK (accepts_used IN (0, 1)),
  accepts_recycled INTEGER NOT NULL DEFAULT 0 CHECK (accepts_recycled IN (0, 1)),

  source_id       TEXT,
  wanted_by       TEXT,
  expires_at      TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_request_status ON request(status, created_at DESC);
CREATE INDEX idx_request_category ON request(category_id, status);
CREATE INDEX idx_request_location ON request(location_id, status);
CREATE INDEX idx_request_urgency ON request(urgency, status);
CREATE INDEX idx_request_requester ON request(requester_user_id);
CREATE INDEX idx_request_bucket ON request(requester_bucket);
CREATE INDEX idx_request_expiry ON request(expires_at) WHERE expires_at IS NOT NULL;

-- The concrete things wanted. A request is an intent; a request item is
-- something that could be listed as a product and matched exactly.
CREATE TABLE request_item (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL,
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  condition_preference TEXT CHECK (condition_preference IS NULL OR condition_preference IN (
                       'new','refurbished','used_good','used_fair','for_parts','any'
                     )),
  skill_id           TEXT REFERENCES skill(id) ON DELETE SET NULL,
  notes              TEXT,
  is_filled          INTEGER NOT NULL DEFAULT 0 CHECK (is_filled IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (request_id, slug)
);

CREATE INDEX idx_request_item_request ON request_item(request_id);
CREATE INDEX idx_request_item_skill ON request_item(skill_id);

CREATE TABLE request_offer (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  business_id    TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  message        TEXT,
  price          REAL,
  status         TEXT NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted','accepted','declined','withdrawn','completed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- One business makes one offer per request. Re-offering is an update, not a
  -- new row, so a provider cannot inflate a request's offer count.
  UNIQUE (request_id, business_id)
);

CREATE INDEX idx_request_offer_request ON request_offer(request_id, status);
CREATE INDEX idx_request_offer_business ON request_offer(business_id, created_at DESC);

-- Status history. A marketplace request that changes hands is a record that
-- providers and requesters both need, and it is the evidence behind the
-- "time to match" metric the lab reports.
CREATE TABLE request_status_event (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_request_status_event_request ON request_status_event(request_id, created_at);
