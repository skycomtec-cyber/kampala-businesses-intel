-- 006: intelligence
-- Trends, gaps and opportunities, with their inputs stored next to their
-- results.
--
-- The rule this file exists to enforce: a number shown in the lab must be
-- explainable. Every gap row carries the measurements it was computed from
-- (`searches`, `supply_count`, `supply_score`, `distinct_actors`,
-- `average_result_quality`, `trend_*`) alongside the score derived from them,
-- and the scoring formula lives in `src/core/intelligence.js` rather than in a
-- SQL view. Recomputing a gap from its own row must reproduce its score; that
-- is checkable, and a view would make it uncheckable.
--
-- Privacy is enforced here too, at write time rather than only at read time. A
-- gap below the k-anonymity floor is written with `suppressed = 1` and a zero
-- score, never with a real score that a caller might forget to filter.

-- A daily count of what exists, per coverage location and per category.
--
-- Supply changes slowly and demand changes fast, so keeping the supply side as
-- an explicit time series is what makes "demand rose because supply fell" a
-- question the platform can answer rather than guess at.
CREATE TABLE supply_metric_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  day             TEXT NOT NULL,
  location_id     TEXT REFERENCES location(id) ON DELETE CASCADE,
  coverage_level  TEXT,
  category_id     TEXT REFERENCES category(id) ON DELETE CASCADE,
  skill_id        TEXT REFERENCES skill(id) ON DELETE CASCADE,

  business_count  INTEGER NOT NULL DEFAULT 0,
  service_count   INTEGER NOT NULL DEFAULT 0,
  product_count   INTEGER NOT NULL DEFAULT 0,
  -- Sum of core/business.js supplyWeight over the businesses in scope. The gap
  -- engine divides by 5 to obtain supplyAdequacy, so a score of 5.0 means the
  -- need is demonstrably covered and one unverified listing never is.
  supply_score    REAL NOT NULL DEFAULT 0,
  verified_count  INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (day, location_id, category_id, skill_id)
);

CREATE INDEX idx_supply_metric_lookup ON supply_metric_daily(day DESC, location_id, category_id);
CREATE INDEX idx_supply_metric_skill ON supply_metric_daily(skill_id, day DESC);
CREATE INDEX idx_supply_metric_day ON supply_metric_daily(day DESC);

-- One computed gap. Append-only within a run: gaps are recomputed rather than
-- updated in place, so the history of how a gap's score moved is retained.
CREATE TABLE gap_snapshot (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT REFERENCES intelligence_run(id) ON DELETE CASCADE,
  computed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- The gap's identity: what was searched for, and where.
  phrase              TEXT NOT NULL,
  term                TEXT NOT NULL,
  ngram_size          INTEGER NOT NULL CHECK (ngram_size BETWEEN 1 AND 3),
  location_id         TEXT REFERENCES location(id) ON DELETE CASCADE,
  coverage_level      TEXT,
  category_id         TEXT REFERENCES category(id) ON DELETE SET NULL,
  skill_id            TEXT REFERENCES skill(id) ON DELETE SET NULL,
  location_name       TEXT,

  -- Window the demand was measured over, in days. Stored because a gap
  -- computed over 30 days and one computed over 90 are not comparable, and
  -- without this column the lab would compare them anyway.
  window_days         INTEGER NOT NULL DEFAULT 30,
  window_start        TEXT,
  window_end          TEXT,

  -- The inputs, verbatim.
  searches            INTEGER NOT NULL DEFAULT 0,
  distinct_actors     INTEGER NOT NULL DEFAULT 0,
  supply_count        INTEGER NOT NULL DEFAULT 0,
  supply_score        REAL NOT NULL DEFAULT 0,
  specificity         REAL NOT NULL DEFAULT 0,
  average_result_quality TEXT NOT NULL DEFAULT 'zero'
                        CHECK (average_result_quality IN ('zero','none_in_area','single','thin','healthy')),

  -- The trend inputs, from core/intelligence.js detectTrend over a daily series.
  trend_direction     TEXT NOT NULL DEFAULT 'insufficient_data',
  trend_ratio         REAL,
  trend_delta         REAL NOT NULL DEFAULT 0,

  -- The derived values.
  gap_score           REAL NOT NULL DEFAULT 0,
  severity            TEXT NOT NULL DEFAULT 'none'
                        CHECK (severity IN ('none','low','moderate','high','critical')),

  -- Privacy. A gap that did not clear the k floor is stored with a zero score
  -- and this flag set, so the suppression travels with the row into any export
  -- or report rather than depending on the reader to remember.
  suppressed          INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
  k_threshold         INTEGER NOT NULL DEFAULT 5,

  -- The full input object as JSON, so a score can be recomputed from the row
  -- alone even if the formula changes later.
  inputs_json         TEXT NOT NULL DEFAULT '{}',

  UNIQUE (run_id, phrase, location_id, ngram_size)
);

CREATE INDEX idx_gap_snapshot_run ON gap_snapshot(run_id, severity DESC, gap_score DESC);
CREATE INDEX idx_gap_snapshot_phrase ON gap_snapshot(phrase, computed_at DESC);
CREATE INDEX idx_gap_snapshot_location ON gap_snapshot(location_id, computed_at DESC);
CREATE INDEX idx_gap_snapshot_category ON gap_snapshot(category_id, severity);
CREATE INDEX idx_gap_snapshot_computed ON gap_snapshot(computed_at DESC);
-- Partial index for the one query that matters most: "show me the real gaps".
CREATE INDEX idx_gap_snapshot_visible ON gap_snapshot(computed_at DESC, severity, gap_score DESC)
  WHERE suppressed = 0;

-- A confirmed gap promoted to something a person can act on.
--
-- An opportunity is a hypothesis with a stated rationale, never a promise. The
-- `rationale` column is the human-readable reason derived in
-- core/intelligence.js deriveOpportunity, and it is stored so the lab can show
-- the reasoning instead of only the number.
CREATE TABLE opportunity (
  id                TEXT PRIMARY KEY,
  gap_snapshot_id   TEXT REFERENCES gap_snapshot(id) ON DELETE SET NULL,

  keyword           TEXT NOT NULL,
  location_id       TEXT REFERENCES location(id) ON DELETE SET NULL,
  location_name     TEXT,
  coverage_level    TEXT,
  category_id       TEXT REFERENCES category(id) ON DELETE SET NULL,

  severity          TEXT NOT NULL DEFAULT 'none'
                      CHECK (severity IN ('none','low','moderate','high','critical')),
  score             REAL NOT NULL DEFAULT 0,
  estimated_monthly_searches INTEGER NOT NULL DEFAULT 0,
  supply_count      INTEGER NOT NULL DEFAULT 0,
  trend_direction   TEXT NOT NULL DEFAULT 'insufficient_data',
  rationale         TEXT NOT NULL,
  suggested_action  TEXT,

  state             TEXT NOT NULL DEFAULT 'candidate'
                      CHECK (state IN ('candidate','validating','actionable','dismissed','acted_on')),
  -- Why a state changed, and by whom. An opportunity that is dismissed without
  -- a reason is the fastest way to make the lab untrustworthy.
  state_reason      TEXT,
  state_changed_at  TEXT,
  state_changed_by  TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  acted_on_at       TEXT,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- An opportunity is identified by what it is about, not by when it was
  -- found, so a re-run refreshes the existing row instead of creating a
  -- duplicate the user then has to dismiss again.
  UNIQUE (keyword, location_id)
);

CREATE INDEX idx_opportunity_state ON opportunity(state, score DESC);
CREATE INDEX idx_opportunity_location ON opportunity(location_id, score DESC);
CREATE INDEX idx_opportunity_severity ON opportunity(severity, score DESC);
CREATE INDEX idx_opportunity_created ON opportunity(created_at DESC);

-- The audit trail for every intelligence computation.
--
-- A gap engine that silently fails is worse than no gap engine, because the
-- lab will show a confident, stale, empty picture. Recording each run with its
-- window, its counts and its errors is what lets the lab state "last computed
-- 3 days ago, 41 gaps, 12 suppressed" instead of implying live data.
CREATE TABLE intelligence_run (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL DEFAULT 'gaps'
                      CHECK (kind IN ('gaps','demand_rollup','supply_rollup','opportunities')),
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed')),
  window_days       INTEGER NOT NULL DEFAULT 30,
  window_start      TEXT,
  window_end        TEXT,
  k_threshold       INTEGER NOT NULL DEFAULT 5,

  searches_seen     INTEGER NOT NULL DEFAULT 0,
  gaps_written      INTEGER NOT NULL DEFAULT 0,
  -- Aggregates that did not clear the k floor. Surfaced in the lab: a high
  -- suppression rate is itself a finding, usually a location level too fine.
  gaps_suppressed   INTEGER NOT NULL DEFAULT 0,
  opportunities_written INTEGER NOT NULL DEFAULT 0,
  opportunities_advanced INTEGER NOT NULL DEFAULT 0,

  error             TEXT,
  notes             TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at       TEXT
);

CREATE INDEX idx_intelligence_run_status ON intelligence_run(status, started_at DESC);
CREATE INDEX idx_intelligence_run_kind ON intelligence_run(kind, started_at DESC);

-- Rolling platform-level counters, so the public site can show "we have indexed
-- N businesses across M districts" without a full-table count on every request.
CREATE TABLE platform_stat (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
