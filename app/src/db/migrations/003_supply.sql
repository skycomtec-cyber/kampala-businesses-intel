-- 003: supply
-- Businesses and everything they offer or can do.

CREATE TABLE business (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  description        TEXT,
  category_id        TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,

  -- Primary location is denormalised onto the business because almost every
  -- read path needs it, and joining through a separate table for that would be
  -- the single most common join in the platform.
  primary_location_id TEXT NOT NULL REFERENCES location(id) ON DELETE RESTRICT,

  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','active','suspended','closed')),
  verification_state TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (verification_state IN ('unverified','claimed','pending_review','verified','rejected')),
  capability_level   TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (capability_level IN ('unverified','claimed','documented','operating','established')),

  website            TEXT,
  founded_year       INTEGER,
  -- Where this record came from. A business created in the admin UI, one
  -- imported from a spreadsheet and one claimed by its owner all have different
  -- trust properties, and the gap engine needs to know which is which.
  source_id          TEXT,
  is_open_source     INTEGER CHECK (is_open_source IN (0, 1)),

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at        TEXT,
  last_confirmed_at  TEXT
);

CREATE INDEX idx_business_category ON business(category_id);
CREATE INDEX idx_business_location ON business(primary_location_id);
CREATE INDEX idx_business_status ON business(status, verification_state);
CREATE INDEX idx_business_name ON business(name);

-- A business can operate from several places: a workshop in Nakawa and a
-- collection point in Entebbe are one business with two locations.
CREATE TABLE business_location (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES location(id) ON DELETE RESTRICT,
  address_text  TEXT,
  latitude      REAL,
  longitude     REAL,
  is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_business_location_unique ON business_location(business_id, location_id);
CREATE INDEX idx_business_location_location ON business_location(location_id);

-- Contact points are normalised on write (see core/identifiers.js), which makes
-- the unique index below a genuine deduplication mechanism: two records with
-- the same canonical phone are the same business.
CREATE TABLE contact_point (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('phone','whatsapp','email','website','facebook','tiktok','physical')),
  value         TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  -- Contact details are the most sensitive thing a business listing holds.
  -- is_public defaults to false so a number can be collected and verified
  -- before it is ever exposed.
  is_public     INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_contact_unique ON contact_point(business_id, kind, value);
CREATE INDEX idx_contact_value ON contact_point(kind, value);
CREATE INDEX idx_contact_public ON contact_point(business_id) WHERE is_public = 1;

-- What a business does. Services are the unit the search engine matches
-- against natural language, so they carry their own description text.
CREATE TABLE service (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  price_min       REAL,
  price_max       REAL,
  price_unit      TEXT CHECK (price_unit IS NULL OR price_unit IN ('hour','job','item','day','month','quote')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (business_id, slug)
);

CREATE INDEX idx_service_category ON service(category_id);
CREATE INDEX idx_service_business ON service(business_id);
CREATE INDEX idx_service_name ON service(name);

-- What a business sells or has available. Second Life Electronics depends on
-- `condition` and `is_recyclable` to separate resale, parts recovery and
-- recycling into distinct supply.
CREATE TABLE product (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  condition       TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (condition IN ('new','refurbished','used_good','used_fair','for_parts','unknown')),
  quantity        INTEGER,
  price_min       REAL,
  price_max       REAL,
  currency        TEXT NOT NULL DEFAULT 'UGX',
  is_recyclable   INTEGER NOT NULL DEFAULT 0 CHECK (is_recyclable IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','sold','withdrawn')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (business_id, slug)
);

CREATE INDEX idx_product_category ON product(category_id);
CREATE INDEX idx_product_business ON product(business_id);
CREATE INDEX idx_product_name ON product(name);
CREATE INDEX idx_product_condition ON product(condition, status);
CREATE INDEX idx_product_recyclable ON product(is_recyclable, status) WHERE is_recyclable = 1;

-- Capabilities, many-to-many with both business and category. The join table to
-- category is what lets the supply engine answer "how many electricians are
-- there" without a hardcoded mapping of categories to professions.
CREATE TABLE business_skill (
  business_id TEXT NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  skill_id    TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  -- How central this skill is to the business, 0 to 1. A shop that fixes
  -- phones occasionally is not a phone repair business.
  proficiency REAL NOT NULL DEFAULT 0.5 CHECK (proficiency >= 0 AND proficiency <= 1),
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (business_id, skill_id)
);

CREATE INDEX idx_business_skill_skill ON business_skill(skill_id);

CREATE TABLE category_skill (
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  skill_id    TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, skill_id)
);

CREATE TABLE service_skill (
  service_id TEXT NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, skill_id)
);
