import crypto from 'node:crypto'
import { PrivacyThresholdError } from './errors.js'

/**
 * Privacy rules, enforced at the domain layer.
 *
 * These are not advisory. `suppressIfBelowK` throws rather than returning a
 * redacted value, because a redacted value that is accidentally returned to a
 * caller is a privacy breach, whereas a thrown error is a visible failure.
 *
 * The threat model this addresses: aggregates derived from search and
 * interaction data can re-identify individuals. A single search for
 * "abortion clinic Kireka" from one location, aggregated by location, tells you
 * something about one specific person. The k-anonymity floor is what stops the
 * platform from publishing that.
 */

export const DEFAULT_K_THRESHOLD = 5

export function assertKThreshold(value) {
  const k = Number(value)
  if (!Number.isInteger(k) || k < 2) {
    throw new TypeError('k-anonymity threshold must be an integer of at least 2.')
  }
  return k
}

/**
 * Rotating salt for pseudonymisation.
 *
 * Rotating the salt is what makes the demand signal usable without becoming a
 * tracking profile. A stable per-user hash would let the platform reconstruct
 * an individual's browsing history indefinitely. A salt that changes daily
 * means the platform can count "how many people searched X in this district
 * this week" while being structurally unable to follow one person across days.
 *
 * The cost is honest and accepted: day-boundary visitors count as separate
 * actors, which slightly over-counts. Over-counting is the safe direction to
 * err in.
 */
export function pseudonymise({ salt, actorSeed }) {
  if (!salt || !actorSeed) {
    throw new TypeError('pseudonymise requires both salt and actorSeed.')
  }
  return crypto
    .createHmac('sha256', salt)
    .update(String(actorSeed))
    .digest('base64url')
    .slice(0, 32)
}

/** Derives the salt for a given day, so rotation is deterministic and stateless. */
export function dailySalt(masterSecret, date) {
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date)
  return crypto
    .createHmac('sha256', masterSecret)
    .update(`rotation:${day}`)
    .digest('base64url')
}

/**
 * Everything that is deliberately NOT stored about a person.
 *
 * The platform records the salt, never the IP; the resulting pseudonymous
 * bucket, never a device identifier; a day, never a precise timestamp on the
 * anonymous aggregate. This function is the single place that decides what
 * leaves the request, so an engineer adding a new field has one obvious place
 * to look before they add something identifying by accident.
 */
export function sanitiseEventContext({ ip, userAgent, referrer, path, ...rest }) {
  void ip
  void userAgent
  void referrer
  void path
  return rest
}

/**
 * Applies the k-anonymity floor to an aggregate row.
 *
 * `distinctActors` is the count of unique daily pseudonymous buckets behind
 * the aggregate. Below the threshold, the aggregate is not merely hidden from
 * the public API; it is refused, so the same protection applies to internal
 * dashboards and to any future "Ask Kampala" retrieval path.
 */
export function suppressIfBelowK(row, kThreshold = DEFAULT_K_THRESHOLD) {
  const k = assertKThreshold(kThreshold)
  const actors = row?.distinctActors ?? 0
  if (actors < k) {
    return { visible: false, suppressed: true, row: null, kThreshold: k }
  }
  return { visible: true, suppressed: false, row, kThreshold: k }
}

/** Strict variant for paths that must not return a suppressed value at all. */
export function requireK(row, kThreshold = DEFAULT_K_THRESHOLD) {
  const result = suppressIfBelowK(row, kThreshold)
  if (result.suppressed) {
    throw new PrivacyThresholdError(
      {
        ...row,
        distinctActors: undefined,
        suppressed: true,
      },
      result.kThreshold,
    )
  }
  return result.row
}

/**
 * Combines raw counts into a single bucketed value so that publishing a
 * histogram of a small group does not leak exact counts. Returns the bucket
 * label, not the number.
 */
export function bucketCount(count) {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2-3'
  if (count <= 10) return '4-10'
  if (count <= 50) return '11-50'
  if (count <= 200) return '51-200'
  return '200+'
}
