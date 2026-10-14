import { ValidationError } from './errors.js'

/**
 * Distance on a sphere, for "what is near me".
 *
 * The directory can already answer "what is in Nakawa", but the question a
 * person actually asks with a phone in their hand is "what is close to where I
 * am standing", and a ward boundary is not an answer to that. This file is the
 * whole of the arithmetic that question needs, kept pure so a test can place two
 * points a known number of kilometres apart without a database or a clock.
 *
 * The earth is a sphere here rather than an ellipsoid. Over the distances a
 * person walks or drives to a shop this is accurate to well under a percent, and
 * the alternative — a geodesic library — buys precision the platform cannot use
 * and hides a mistake the platform cannot afford: a radius filter whose accuracy
 * nobody can check by reading it.
 */

/** Mean earth radius in kilometres (IUGG). */
export const EARTH_RADIUS_KM = 6371.0088

/**
 * The largest radius the directory will search.
 *
 * A caller who asks for a ten-thousand-kilometre radius is not asking about
 * proximity, they are asking for the whole table sorted by a number that is
 * meaningless at that scale. Refusing it keeps "near me" a real question.
 */
export const MAX_RADIUS_KM = 500

/** Uganda sits near the equator; this is the box the platform actually serves. */
export const KAMPALA = Object.freeze({ lat: 0.3476, lng: 32.5825 })

export function assertLatitude(value, field = 'lat') {
  const number = Number(value)
  if (!Number.isFinite(number) || number < -90 || number > 90) {
    throw new ValidationError('Latitude must be a number between -90 and 90.', { field })
  }
  return number
}

export function assertLongitude(value, field = 'lng') {
  const number = Number(value)
  if (!Number.isFinite(number) || number < -180 || number > 180) {
    throw new ValidationError('Longitude must be a number between -180 and 180.', { field })
  }
  return number
}

/**
 * A caller's own position, or a refusal.
 *
 * Latitude and longitude are validated together because half a coordinate is
 * not a place: a request that carried one and not the other is a client bug, and
 * quietly defaulting the missing half to Kampala would answer a question nobody
 * asked with a location nobody chose.
 */
export function normalisePoint({ lat, lng } = {}) {
  const hasLat = lat !== undefined && lat !== null && lat !== ''
  const hasLng = lng !== undefined && lng !== null && lng !== ''
  if (!hasLat && !hasLng) return null
  if (!hasLat || !hasLng) {
    throw new ValidationError('A location needs both a latitude and a longitude.', {
      field: hasLat ? 'lng' : 'lat',
    })
  }
  return { lat: assertLatitude(lat), lng: assertLongitude(lng) }
}

export function normaliseRadius(value, { field = 'radiusKm' } = {}) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new ValidationError('A radius must be a positive number of kilometres.', { field })
  }
  if (number > MAX_RADIUS_KM) {
    throw new ValidationError(`A radius may not exceed ${MAX_RADIUS_KM} kilometres.`, { field })
  }
  return number
}

/** Great-circle distance in kilometres, to two decimals of uselessness avoided. */
export function haversineKm(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * A rounded distance, for display.
 *
 * Kept here rather than in a page so the api and every client round the same
 * way: 0.4 km is a walk and 0.6 km is a walk, and a page that rounded a little
 * differently from the number beside it would read as two distances.
 */
export function roundKm(km) {
  return Math.round(km * 10) / 10
}

/**
 * A square that contains the radius circle, in degrees.
 *
 * Used to cut the rows the exact haversine has to look at. It is deliberately
 * generous — a bounding box always contains its circle — because its only job is
 * to remove points that cannot possibly be in range, never to be the range.
 */
export function boundingBox(point, radiusKm) {
  const latDelta = radiusKm / 111.32
  const cos = Math.cos((point.lat * Math.PI) / 180)
  // Near the poles a degree of longitude shrinks to nothing; clamp the divisor
  // so the box widens to the whole longitude range rather than exploding.
  const lngDelta = cos > 0.01 ? radiusKm / (111.32 * cos) : 180
  return {
    minLat: Math.max(-90, point.lat - latDelta),
    maxLat: Math.min(90, point.lat + latDelta),
    minLng: Math.max(-180, point.lng - lngDelta),
    maxLng: Math.min(180, point.lng + lngDelta),
  }
}
