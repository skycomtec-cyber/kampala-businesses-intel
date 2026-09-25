import { ValidationError } from './errors.js'
import { slugify, normalisePhone, normaliseUrl, isValidEmail } from './identifiers.js'
import { CAPABILITY_RANK, assertCapabilityLevel } from './taxonomy.js'

/**
 * Supply-side domain rules.
 *
 * A business is the atomic unit of supply. Services and products hang off it.
 * This is the model the "Second Life Electronics" vertical depends on: a
 * repairer is a business, "laptop screen replacement" is a service on that
 * business, and "used ThinkPad battery" is a product on it.
 *
 * Verification state is tracked separately from capability level. A business can
 * be confidently known to exist (verification) and still offer only informal
 * services (capability), and the two must not be collapsed into one score.
 */

export const VERIFICATION_STATES = Object.freeze([
  'unverified',
  'claimed',
  'pending_review',
  'verified',
  'rejected',
])

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
  if (!VERIFICATION_STATES.includes(state)) {
    throw new ValidationError(`Unknown verification state "${state}".`, {
      allowed: VERIFICATION_STATES,
    })
  }
  return state
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
  const verificationState = assertVerificationState(
    input.verificationState ?? 'unverified',
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

/** Two businesses at the same place with the same phone are the same business. */
export function contactPointsLikelySameBusiness(a, b) {
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'physical') return normaliseWhitespace(a.value) === normaliseWhitespace(b.value)
  return a.value === b.value
}

export function capabilityWeight(level) {
  return CAPABILITY_RANK[level] ?? 0
}

/**
 * Whether a listing may be shown in public search results. A listing is
 * public only if the business is active, and we never let a business escalate
 * itself out of the unverified state: verification is an editorial decision.
 */
export function isPubliclyVisible(business) {
  return business.status === 'active' && business.verificationState !== 'rejected'
}

/**
 * Whether a listing counts toward supply in gap analysis. Unverified businesses
 * still count, but at a reduced weight, so that the gap engine does not
 * conclude a market is well supplied on the strength of unconfirmed claims
 * while still not discarding the signal entirely.
 */
export function supplyWeight(business) {
  if (!isPubliclyVisible(business)) return 0
  const base = 0.5
  const byVerification = {
    verified: 0.5,
    claimed: 0.35,
    pending_review: 0.3,
    unverified: 0.15,
    rejected: 0,
  }
  return base + (byVerification[business.verificationState] ?? 0) + capabilityWeight(business.capabilityLevel) * 0.05
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
