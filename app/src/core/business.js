import { ValidationError } from './errors.js'
import { slugify, normalisePhone, normaliseUrl, isValidEmail } from './identifiers.js'
import { CAPABILITY_RANK, assertCapabilityLevel } from './taxonomy.js'
import {
  REVIEW_STATES,
  PUBLISHED_STATE,
  assertReviewState,
} from './catalogue.js'

/**
 * Supply-side domain rules.
 *
 * A business is the atomic unit of supply. Services and products hang off it.
 * This is the model the "Second Life Electronics" vertical depends on: a
 * repairer is a business, "laptop screen replacement" is a service on that
 * business, and "used ThinkPad battery" is a product on it.
 *
 * Review state is tracked separately from capability level. A business can be
 * confidently known to exist (review) and still offer only informal services
 * (capability), and the two must not be collapsed into one score.
 *
 * The review vocabulary itself lives in catalogue.js, because it is a pipeline
 * with rules about which step may follow which, and those rules are used by the
 * importers and the api layer as much as by this file.
 */

/**
 * Kept as the historical name of the review vocabulary.
 *
 * `business.verification_state` is the column, and it has been called that since
 * the first migration, so the name stays. What the values mean has changed: see
 * catalogue.js. Re-exported rather than re-declared so there is exactly one list
 * in the codebase that a schema, a route and a test can all be checked against.
 */
export const VERIFICATION_STATES = REVIEW_STATES

export const BUSINESS_STATUSES = Object.freeze([
  'draft',
  'active',
  'suspended',
  'closed',
])

export const PRODUCT_CONDITIONS = Object.freeze([
  'new',
  'refurbished',
  'used_good',
  'used_fair',
  'for_parts',
  'unknown',
])

/**
 * The units a service price can be quoted in.
 *
 * This list has to stay identical to the CHECK constraint on
 * `service.price_unit` in 003_supply.sql, because until now it was the *only*
 * place the rule existed. That made the database the validator: an operator who
 * typed "per hour" got a 500 from a CHECK violation instead of the 400 that every
 * other validation failure in this platform returns, and nothing in the codebase
 * could enumerate the units for a form because no JavaScript knew them.
 * Declaring the vocabulary here is what lets the error name its field, and what
 * lets a client build the list.
 */
export const PRICE_UNITS = Object.freeze([
  'hour',
  'job',
  'item',
  'day',
  'month',
  'quote',
])

export const CONTACT_KINDS = Object.freeze([
  'phone',
  'whatsapp',
  'email',
  'website',
  'facebook',
  'tiktok',
  'physical',
])

export function assertVerificationState(state) {
  return assertReviewState(state)
}

export function assertBusinessStatus(status) {
  if (!BUSINESS_STATUSES.includes(status)) {
    throw new ValidationError(`Unknown business status "${status}".`, {
      allowed: BUSINESS_STATUSES,
    })
  }
  return status
}

export function assertProductCondition(condition) {
  if (!PRODUCT_CONDITIONS.includes(condition)) {
    throw new ValidationError(`Unknown product condition "${condition}".`, {
      allowed: PRODUCT_CONDITIONS,
    })
  }
  return condition
}

/**
 * Normalises a price unit, or refuses it.
 *
 * `null` and `undefined` pass, because a service is allowed to quote a range
 * with no unit at all, and so does a blank string, because an operator who
 * cleared a field should not get told off for it. Anything else has to be one
 * of PRICE_UNITS — including a number, which is refused rather than dropped: a
 * client that sent 5 was wrong about the field, and silently storing null would
 * hide that from both sides.
 */
export function assertPriceUnit(unit) {
  if (unit === null || unit === undefined) return null
  if (typeof unit !== 'string') {
    throw new ValidationError(`Price unit must be a string, got ${typeof unit}.`, {
      field: 'priceUnit',
      allowed: PRICE_UNITS,
    })
  }
  const value = unit.trim()
  if (value === '') return null
  if (!PRICE_UNITS.includes(value)) {
    throw new ValidationError(`Unknown price unit "${unit}".`, {
      field: 'priceUnit',
      allowed: PRICE_UNITS,
    })
  }
  return value
}

/**
 * Builds a valid business from untrusted input. Every write path in the
 * platform funnels through here, so a business can never enter the database
 * without a name, a category, a valid location and an explicit status.
 */
export function buildBusiness(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < 2 || name.length > 160) {
    throw new ValidationError('A business name must be 2 to 160 characters.', {
      field: 'name',
    })
  }
  if (!input.categoryId) {
    throw new ValidationError('A business must belong to a category.', {
      field: 'categoryId',
    })
  }
  if (!input.locationId) {
    throw new ValidationError('A business must have a primary location.', {
      field: 'locationId',
    })
  }

  const status = assertBusinessStatus(input.status ?? 'draft')
  // A business written by hand is not raw intake, but it is also not checked, so
  // it enters the review queue rather than appearing in public view. Callers that
  // are ingesting from a source pass `imported` or the state the source claims;
  // nothing passes `approved` without going through the review pipeline.
  const verificationState = assertVerificationState(
    input.verificationState ?? 'pending_review',
  )
  const capabilityLevel = assertCapabilityLevel(
    input.capabilityLevel ?? 'unverified',
  )

  return {
    name,
    slug: slugify(input.slug || name),
    description: clampText(input.description, 4000),
    categoryId: input.categoryId,
    primaryLocationId: input.locationId,
    status,
    verificationState,
    capabilityLevel,
    foundedYear:
      typeof input.foundedYear === 'number' &&
      input.foundedYear >= 1800 &&
      input.foundedYear <= 2100
        ? input.foundedYear
        : null,
    website: normaliseUrl(input.website),
    isOpenSource: input.isOpenSource ?? null,
  }
}

/**
 * A contact point is normalised on the way in and validated on its own terms.
 * We never store a phone number that we cannot round-trip to a canonical form,
 * because an unnormalised number is a number that will never match another
 * business's number during deduplication or supply counting.
 */
export function buildContactPoint(input) {
  const kind = input.kind
  if (!CONTACT_KINDS.includes(kind)) {
    throw new ValidationError(`Unknown contact kind "${kind}".`, {
      allowed: CONTACT_KINDS,
    })
  }

  let value
  switch (kind) {
    case 'phone':
    case 'whatsapp': {
      value = normalisePhone(input.value)
      if (!value) {
        throw new ValidationError(
          `"${input.value}" is not a valid Ugandan phone number.`,
          { field: 'value' },
        )
      }
      break
    }
    case 'email': {
      if (!isValidEmail(input.value)) {
        throw new ValidationError(`"${input.value}" is not a valid email address.`, {
          field: 'value',
        })
      }
      value = input.value.trim().toLowerCase()
      break
    }
    case 'website':
    case 'facebook':
    case 'tiktok': {
      value = normaliseUrl(input.value)
      if (!value) {
        throw new ValidationError(`"${input.value}" is not a valid URL.`, {
          field: 'value',
        })
      }
      break
    }
    default: {
      value = clampText(input.value, 500)
      if (!value) {
        throw new ValidationError('An address cannot be empty.', { field: 'value' })
      }
    }
  }

  return {
    kind,
    value,
    isPrimary: Boolean(input.isPrimary),
    isPublic: input.isPublic ?? true,
  }
}

/** Contact kinds whose value is a phone number. */
export const PHONE_KINDS = Object.freeze(new Set(['phone', 'whatsapp']))

/** Two businesses at the same place with the same phone are the same business. */
export function contactPointsLikelySameBusiness(a, b) {
  if (!a || !b) return false
  // phone and whatsapp are the same identity: the same digits, stored under
  // whichever kind the operator typed.
  if (PHONE_KINDS.has(a.kind) && PHONE_KINDS.has(b.kind)) {
    return normalisePhone(a.value) === normalisePhone(b.value)
  }
  if (a.kind !== b.kind) return false
  if (a.kind === 'physical') return normaliseWhitespace(a.value) === normaliseWhitespace(b.value)
  if (a.kind === 'email') return a.value.toLowerCase() === b.value.toLowerCase()
  return normaliseUrl(a.value) === normaliseUrl(b.value)
}

/**
 * The value as it is stored, for looking a contact up.
 *
 * Returns null rather than throwing for a value the platform would refuse to
 * store, because a duplicate check asks "is this the same business?", and an
 * unusable value is simply not an answer to that question. Sharing
 * buildContactPoint is what keeps a lookup and a write in agreement about what
 * "the same" means.
 */
export function canonicalContactValue(kind, value) {
  try {
    return buildContactPoint({ kind, value }).value
  } catch {
    return null
  }
}

export function capabilityWeight(level) {
  return CAPABILITY_RANK[level] ?? 0
}

/**
 * Whether a listing may be shown to the public.
 *
 * This is the rule the whole phase turns on, and it is stricter than it used to
 * be: before the review pipeline, any active business that had not been rejected
 * was public, so a row nobody had read looked exactly like a listing the platform
 * stood behind. Now a listing is public only when it is active *and* approved,
 * which means somebody checked the facts and somebody else, or the same person
 * later, agreed to publish them.
 *
 * The two conditions are not one. Approval is a claim about the facts; `active` is
 * a decision about today. A business can be approved and suspended, and the
 * public sees nothing, which is the behaviour an operator expects when a shop
 * closes for a week.
 */
export function isPubliclyVisible(business) {
  return business.status === 'active' && business.verificationState === PUBLISHED_STATE
}

/**
 * How much a business counts toward supply in gap analysis.
 *
 * Unapproved businesses still count, at a reduced weight. Throwing them away
 * instead would be wrong in a way that is hard to see: a queue of a thousand
 * checked-but-unpublished records is a large amount of real evidence about where
 * supply is, and a gap engine that cannot see it would report a market as empty
 * while somebody works through its queue. What it must not do is let an unchecked
 * claim outweigh a verified one, which is what the weights below prevent.
 *
 * Rejected and archived records count for nothing at all. A rejection is a
 * decision that the record is not a real business, and continuing to read supply
 * from it would mean a bad review quietly survives as data.
 */
export function supplyWeight(business) {
  if (business.status !== 'active') return 0
  const byReviewState = {
    approved: 0.5,
    verified: 0.45,
    under_review: 0.3,
    pending_review: 0.25,
    imported: 0.15,
    rejected: 0,
    archived: 0,
  }
  const base = 0.5
  return base + (byReviewState[business.verificationState] ?? 0) + capabilityWeight(business.capabilityLevel) * 0.05
}

function clampText(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function normaliseWhitespace(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim()
}
