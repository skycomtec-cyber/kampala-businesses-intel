import { ValidationError, ConflictError } from './errors.js'
import { isValidEmail, normalisePhone, newId } from './identifiers.js'

/**
 * Business claim rules.
 *
 * A claim is the one place a member of the public asks to be *inside* the
 * directory rather than to be listed in it: "this business is mine, and I want
 * to look after its details." The rules here are pure — no database, no clock —
 * so the api layer, the review queue and the tests all agree on what a claim is
 * and when it may change state.
 *
 * A claim is not an account and not a publication. An anonymous owner who wants
 * a listing does not sign up for anything; they state who they are and how they
 * can be reached, and an operator decides, from the evidence, whether to grant
 * ownership. Granting is when the account appears, and that is a decision with a
 * recorded reason, exactly like publishing a listing.
 */

export const CLAIM_STATUSES = Object.freeze([
  'pending',
  'granted',
  'withdrawn',
  'rejected',
  'revoked',
])

/**
 * The decisions an operator can record about a claim, with the status each one
 * leaves the claim in. `granted` means the claimant now owns the listing;
 * `revoked` is that ownership being taken back, which is why it only exists for
 * a claim that was granted.
 */
export const DECISIONS = Object.freeze({
  grant: 'granted',
  reject: 'rejected',
  revoke: 'revoked',
})

export const DECISION_NAMES = Object.freeze(Object.keys(DECISIONS))

export function assertClaimStatus(status) {
  if (!CLAIM_STATUSES.includes(status)) {
    throw new ValidationError(`Unknown claim status "${status}".`, {
      allowed: CLAIM_STATUSES,
    })
  }
  return status
}

export function assertDecision(decision) {
  if (!Object.hasOwn(DECISIONS, decision)) {
    throw new ValidationError(`Unknown claim decision "${decision}".`, {
      allowed: DECISION_NAMES,
    })
  }
  return decision
}

/**
 * The decisions available on a claim in a given status.
 *
 * A pending claim can be granted or rejected. Only a granted claim can be
 * revoked — a rejection cannot be "revoked" because nothing was ever given. A
 * withdrawn or rejected claim is settled and a fresh claim is the way back in,
 * which is also what prevents a claimant from looping on the same application.
 */
export function legalDecisions(status) {
  assertClaimStatus(status)
  switch (status) {
    case 'pending':
      return ['grant', 'reject']
    case 'granted':
      return ['revoke']
    default:
      return []
  }
}

export function canDecide(status, decision) {
  assertClaimStatus(status)
  assertDecision(decision)
  return legalDecisions(status).includes(decision)
}

/**
 * Refuses a decision the claim is not in a state to accept.
 *
 * A 409 rather than a 400: the request is well formed, the claim simply is not
 * at a point in its life where that decision is possible. Naming the legal
 * decisions is deliberate, so a client can fix itself without a second round
 * trip.
 */
export function assertDecisionForStatus(status, decision) {
  assertClaimStatus(status)
  assertDecision(decision)
  if (!canDecide(status, decision)) {
    throw new ConflictError(
      `A ${status} claim cannot be ${decision}d.`,
      { status, illegalDecision: decision, allowed: legalDecisions(status) },
    )
  }
  return decision
}

/**
 * A claim's contact value, normalised for storage and for matching.
 *
 * Mirrors the normalisation of contact points in core/business.js so that a
 * phone typed as "0772 123 456" and one listed as "+256772123456" compare equal
 * when the repository decides whether the claim corroborates the listing. The
 * claimant's phone is not stored as a contact point and is not published; it is
 * evidence for the reviewer.
 */
export function normaliseClaimContact(kind, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  if (kind === 'email') {
    const value = String(raw).trim().toLowerCase()
    if (!isValidEmail(value)) {
      throw new ValidationError(`"${raw}" is not a valid email address.`, {
        field: 'contactEmail',
      })
    }
    return value
  }
  const value = normalisePhone(String(raw))
  if (!value) {
    throw new ValidationError(`"${raw}" is not a valid Ugandan phone number.`, {
      field: 'contactPhone',
    })
  }
  return value
}

function clampText(value, max, field) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters.`, {
      field,
    })
  }
  return text
}

/**
 * Builds a valid claim from untrusted input. Every write path funnels through
 * here, so a claim can never enter the database without naming a business, a
 * person and how they relate to it.
 *
 * `matchesContact` is a finding about the listing's own contact points, which
 * only the data layer can compute (it has to read them); the rule for what
 * counts as a match lives in core/business.js and is used by the repository, so
 * this builder receives the verdict rather than guessing at it.
 */
export function buildClaim(input) {
  if (!input.businessId) {
    throw new ValidationError('A claim must name the business being claimed.', {
      field: 'businessId',
    })
  }

  const claimedAs = clampText(input.claimedAs, 160, 'claimedAs')
  if (!claimedAs || claimedAs.length < 2) {
    throw new ValidationError('A claimant name must be 2 to 160 characters.', {
      field: 'claimedAs',
    })
  }

  const relation = clampText(input.relation, 240, 'relation')
  if (!relation || relation.length < 2) {
    throw new ValidationError('A relation to the business must be stated.', {
      field: 'relation',
    })
  }

  return {
    id: newId(),
    businessId: input.businessId,
    claimedAs,
    relation,
    contactEmail: normaliseClaimContact('email', input.contactEmail),
    contactPhone: normaliseClaimContact('phone', input.contactPhone),
    evidence: clampText(input.evidence, 2000, 'evidence'),
    matchesContact: Boolean(input.matchesContact),
    status: 'pending',
  }
}