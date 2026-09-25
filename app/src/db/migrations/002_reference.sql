-- 002: reference data
-- Administrative geography and classification. This is real-world reference
-- data about places and categories, never synthetic business content.

-- A single self-referencing tree. `kind` distinguishes the level, which keeps
-- the hierarchy extensible without a migration per new level.
CREATE TABLE location (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN (
                'country','region','district','city','town',
                'division','subcounty','ward','cluster'
              )),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  parent_id   TEXT REFERENCES location(id) ON DELETE RESTRICT,
  latitude    REAL,
  longitude   REAL,
  -- IANA-free, stable external code (e.g. UG-041 for Wakiso district) so that
  -- reference data can be re-imported from an authoritative source without
  -- orphaning everything that points at it.
  external_code TEXT,
  -- Which dataset and revision this row came from. Reference data is data too.
  source_id   TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (parent_id, slug)
);

-- The unique index has to span the NULL parent, so enforce it separately.
CREATE UNIQUE INDEX idx_location_root_slug ON location(slug) WHERE parent_id IS NULL;
CREATE INDEX idx_location_parent ON location(parent_id);
CREATE INDEX idx_location_kind ON location(kind);
CREATE INDEX idx_location_name ON location(name);
CREATE INDEX idx_location_external ON location(external_code) WHERE external_code IS NOT NULL;

-- Materialised path ("country/region/district/city"). Lets a single query
-- aggregate demand and supply at every level above a location without walking
-- the tree per row. Maintained by trigger so callers cannot desynchronise it.
ALTER TABLE location ADD COLUMN path_ids TEXT;
ALTER TABLE location ADD COLUMN path_names TEXT;
ALTER TABLE location ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_location_path_insert
AFTER INSERT ON location
BEGIN
  UPDATE location
     SET path_ids = CASE
                      WHEN NEW.parent_id IS NULL THEN NEW.id
                      ELSE (SELECT path_ids || '/' || NEW.id FROM location WHERE id = NEW.parent_id)
                    END,
         path_names = CASE
                      WHEN NEW.parent_id IS NULL THEN NEW.name
                      ELSE (SELECT path_names || ' / ' || NEW.name FROM location WHERE id = NEW.parent_id)
                    END,
         depth = CASE
                      WHEN NEW.parent_id IS NULL THEN 0
                      ELSE (SELECT depth + 1 FROM location WHERE id = NEW.parent_id)
                    END
   WHERE id = NEW.id;
END;

-- A rename or re-parent updates this row's own path. Because the materialised
-- path is denormalised onto every descendant, the same change has to reach the
-- whole subtree, which is done by the repository in one statement rather than by
-- string surgery in a trigger.
CREATE TRIGGER trg_location_path_update
AFTER UPDATE OF parent_id, name ON location
WHEN NEW.parent_id IS NOT NULL
BEGIN
  UPDATE location
     SET path_ids  = (SELECT path_ids  || '/' || NEW.id FROM location WHERE id = NEW.parent_id),
         path_names = (SELECT path_names || ' / ' || NEW.name FROM location WHERE id = NEW.parent_id),
         depth      = (SELECT depth + 1 FROM location WHERE id = NEW.parent_id)
   WHERE id = NEW.id;
END;

CREATE TABLE category (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES category(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  -- Icons and ordering for navigation.
  icon        TEXT,
  sort_weight INTEGER NOT NULL DEFAULT 1000,
  -- The vertical this category belongs to, if any. Lets the Second Life
  -- Electronics vertical be served by the same taxonomy without a fork.
  vertical    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  source_id   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_category_root_slug ON category(slug) WHERE parent_id IS NULL;
CREATE INDEX idx_category_parent ON category(parent_id);

-- Materialised slug path, for the same reason location keeps one: a category's
-- full path is needed for breadcrumbs, for a URL, and for "everything under
-- Second Life Electronics" without walking the tree per row.
ALTER TABLE category ADD COLUMN path_slugs TEXT;
ALTER TABLE category ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_category_path_insert
AFTER INSERT ON category
BEGIN
  UPDATE category
     SET path_slugs = CASE
                        WHEN NEW.parent_id IS NULL THEN NEW.slug
                        ELSE (SELECT path_slugs || '/' || NEW.slug FROM category WHERE id = NEW.parent_id)
                      END,
         depth = CASE
                        WHEN NEW.parent_id IS NULL THEN 0
                        ELSE (SELECT depth + 1 FROM category WHERE id = NEW.parent_id)
                      END
   WHERE id = NEW.id;
END;

CREATE TRIGGER trg_category_path_update
AFTER UPDATE OF parent_id ON category
WHEN NEW.parent_id IS NOT NULL
BEGIN
  UPDATE category
     SET path_slugs = (SELECT path_slugs || '/' || NEW.slug FROM category WHERE id = NEW.parent_id),
         depth = (SELECT depth + 1 FROM category WHERE id = NEW.parent_id)
   WHERE id = NEW.id;
END;

-- Skills are an open many-to-many vocabulary, deliberately separate from the
-- category tree. See src/core/taxonomy.js for why.
CREATE TABLE skill (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  synonyms    TEXT NOT NULL DEFAULT '[]',
  -- Which vertical first demanded this skill. Informational only.
  vertical    TEXT,
  source_id   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_skill_name ON skill(name);

-- Provenance for reference data. The Uganda administrative dataset is imported,
-- not hand-written, so it can be re-imported and diffed later.
CREATE TABLE reference_source (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('location', 'category', 'skill')),
  version     TEXT NOT NULL,
  source_uri  TEXT,
  licence     TEXT,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_count   INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);
