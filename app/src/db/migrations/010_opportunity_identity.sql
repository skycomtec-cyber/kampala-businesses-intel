-- 010: nullable_key_identity
--
-- Makes the identity of an opportunity and of a daily supply measurement correct
-- when their scoping columns are NULL.
--
-- The problem, twice. Both tables are keyed on columns that are allowed to be
-- NULL, and in SQLite a UNIQUE constraint treats NULL as distinct from every other
-- value - including another NULL. So the constraint never fires for the rows that
-- matter most:
--
--   * An opportunity whose search was not confined to a place has
--     `location_id IS NULL`, so re-running the engine appended a fresh duplicate of
--     the same countrywide finding every time, and the opportunity list filled with
--     copies a user had to dismiss one at a time.
--   * A supply metric is naturally NULL for a countrywide figure, and NULL for
--     category and skill until a run scopes itself more narrowly.
--
-- The fix in both cases is a UNIQUE index over the *expression* the row is
-- actually keyed on. `IFNULL(col, '')` collapses the NULL case onto the empty
-- string, so "countrywide" and "no category" each become one key, which is the
-- truth: they are the same scope.
--
-- The table-level constraints are deliberately left in place. They remain correct
-- for the non-NULL case, and dropping a UNIQUE constraint in SQLite means
-- rebuilding the table - a much larger change than the bug warrants. These indexes
-- are strictly stronger: they constrain everything the constraints do, plus the
-- NULL cases the constraints miss. The repositories' upserts name these indexes in
-- their ON CONFLICT targets, so the two stay in agreement.

-- The supply metric's key also has to include coverage_level, and the table-level
-- UNIQUE does not: it is declared on (day, location_id, category_id, skill_id)
-- only. So a countrywide, a district-wide and a city-wide measurement of the same
-- day all claim one key even where location_id is set, and the last write silently
-- overwrites the other two. That was invisible while nothing wrote the table.
-- Collapse any duplicates the old constraints already allowed through, before the
-- indexes make them illegal. The engine has never shipped, so in practice this
-- matches nothing; it is here so that a database which has already run the engine
-- against the old schema migrates cleanly instead of failing on a constraint
-- violation. The survivor is the most recently updated row, which is the one
-- carrying the freshest measurement.
DELETE FROM supply_metric_daily
WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid,
           ROW_NUMBER() OVER (
             PARTITION BY day, IFNULL(location_id, ''), IFNULL(coverage_level, ''),
                          IFNULL(category_id, ''), IFNULL(skill_id, '')
             ORDER BY updated_at DESC, rowid ASC
           ) AS survivor
      FROM supply_metric_daily
  )
  WHERE survivor = 1
);

DELETE FROM opportunity
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY keyword, IFNULL(location_id, '')
             ORDER BY updated_at DESC, id ASC
           ) AS survivor
      FROM opportunity
  )
  WHERE survivor = 1
);

CREATE UNIQUE INDEX idx_supply_metric_scope
  ON supply_metric_daily(
    day,
    IFNULL(location_id, ''),
    IFNULL(coverage_level, ''),
    IFNULL(category_id, ''),
    IFNULL(skill_id, '')
  );

CREATE UNIQUE INDEX idx_opportunity_keyword_location
  ON opportunity(keyword, IFNULL(location_id, ''));

