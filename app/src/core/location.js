import { ValidationError } from './errors.js'

/**
 * The administrative geography of Uganda.
 *
 * Location is modelled as a single self-referencing tree rather than separate
 * tables per level. That is deliberate: "search within N kilometres" and
 * "roll demand up to the district" both need to walk one structure, and a
 * single tree keeps the geographic hierarchy extensible when the platform
 * later needs sub-wards, trading centres or informal neighbourhood clusters
 * without a migration.
 *
 * The `kind` column is what distinguishes the levels. It is intentionally a
 * string rather than an enum because the set of levels in use grows over time
 * and adding a level must not require a schema change.
 */

export const LOCATION_KINDS = Object.freeze([
  'country',
  'region',
  'district',
  'city',
  'town',
  'division',
  'subcounty',
  'ward',
  'cluster',
])

/** Levels that are valid parents for a given level. */
const ALLOWED_PARENTS = Object.freeze({
  country: [],
  region: ['country'],
  district: ['region'],
  city: ['district', 'region'],
  town: ['district', 'region', 'city'],
  division: ['city', 'district'],
  subcounty: ['district', 'division'],
  ward: ['subcounty', 'town', 'city'],
  cluster: ['ward', 'subcounty', 'town', 'city', 'district'],
})

export function isLocationKind(kind) {
  return LOCATION_KINDS.includes(kind)
}

export function assertLocationKind(kind) {
  if (!isLocationKind(kind)) {
    throw new ValidationError(
      `Unknown location kind "${kind}".`,
      { allowed: LOCATION_KINDS },
    )
  }
  return kind
}

export function assertParentAllowed(kind, parentKind) {
  assertLocationKind(kind)
  if (parentKind === null || parentKind === undefined) return true
  const allowed = ALLOWED_PARENTS[kind]
  if (!allowed.includes(parentKind)) {
    throw new ValidationError(
      `A "${kind}" cannot be nested inside a "${parentKind}".`,
      { kind, parentKind, allowed },
    )
  }
  return true
}

/** Latitude/longitude in WGS84 decimal degrees, validated to real-world bounds. */
export function validateCoordinates({ latitude, longitude }) {
  if (latitude === null && longitude === null) return { latitude: null, longitude: null }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new ValidationError('Coordinates must both be numbers, or both be null.')
  }
  if (latitude < -90 || latitude > 90) {
    throw new ValidationError('Latitude must be between -90 and 90.')
  }
  if (longitude < -180 || longitude > 180) {
    throw new ValidationError('Longitude must be between -180 and 180.')
  }
  return {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
  }
}

/*
 * The earth-radius maths used to be here as a placeholder, with a comment
 * promising a real haversine later. It is now real and lives in `core/geo.js`,
 * which is where "near me" reads it from. Keeping two copies would mean two
 * numbers to drift apart, and `export *` from the core barrel would re-export
 * both under the same name and make that name unimportable, so the placeholder
 * is gone rather than left alongside its replacement.
 */

/**
 * The levels a search can be scoped at, and the levels every rollup and gap is
 * reported on, so that comparing a district against a single ward is impossible
 * by construction: a number always carries the level it was computed at.
 *
 * This is the location vocabulary, not a shorter list of it. A search scoped to
 * somewhere has to be able to say *where*, and every kind in the tree is a place
 * a person can be: the platform seeds all five Kampala divisions, offers them in
 * the public area picker, and stores businesses against them. Leaving the finer
 * kinds out of this list did not make their demand unmeasurable, it made it
 * unrepresentable - a search scoped to a division was rejected outright, because
 * the only level available to attribute it to was one the division did not match.
 *
 * Deriving it from LOCATION_KINDS rather than restating it is the point. The two
 * drifted once already, and the symptom was a public search returning 400 for a
 * choice the UI had just offered.
 *
 * The order is a ranking from least to most specific, which is what lets a window
 * spanning several days name the finest level any of them was recorded at. It is
 * a ranking, not a description of the tree: the hierarchy is a dag rather than a
 * chain (a town sits inside a district, and a division is a peer of a subcounty
 * rather than a child of a town), so this total order is a simplification. It is
 * only ever used to pick one name for a mixed window, never to infer containment.
 */
export const COVERAGE_LEVELS = LOCATION_KINDS

export function assertCoverageLevel(level) {
  if (!COVERAGE_LEVELS.includes(level)) {
    throw new ValidationError(
      `Unknown coverage level "${level}".`,
      { allowed: COVERAGE_LEVELS },
    )
  }
  return level
}
