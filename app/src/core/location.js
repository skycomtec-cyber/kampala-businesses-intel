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

/**
 * Approximate radius of the Earth in kilometres. The platform does not do
 * geodesic distance in Phase 1; it buckets locations by administrative level
 * and only uses this to sanity-check radius filters. Haversine arrives with the
 * Postgres/PostGIS adapter, not before.
 */
export const EARTH_RADIUS_KM = 6371

export function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The coverage levels the platform reports on. Every metric rollup and gap is
 * computed at one of these so that comparing a district against a single ward
 * is impossible by construction.
 */
export const COVERAGE_LEVELS = Object.freeze([
  'country',
  'region',
  'district',
  'city',
  'town',
  'subcounty',
])

export function assertCoverageLevel(level) {
  if (!COVERAGE_LEVELS.includes(level)) {
    throw new ValidationError(
      `Unknown coverage level "${level}".`,
      { allowed: COVERAGE_LEVELS },
    )
  }
  return level
}
