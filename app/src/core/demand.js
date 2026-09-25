import { ValidationError } from './errors.js'

/**
 * Demand-side domain rules.
 *
 * This is where the platform's actual intelligence asset lives. A search
 * someone typed is a statement of need. The rules below decide what is
 * recorded about it, and — just as importantly — what is deliberately thrown
 * away before it is written.
 *
 * The guiding principle from the product brief: every interaction should
 * potentially make the platform smarter, without turning people's private
 * information into the product.
 */

/**
 * A search is only a demand signal if it expresses an intent we can act on.
 * These are navigational artefacts, not demand, and counting them would poison
 * every trend we compute.
 */
const NON_DEMAND_PATTERNS = [
  /^(login|log in|signin|sign in|signup|sign up|register|logout|log out)$/,
  /^(home|about|contact|privacy|terms|help|faq|admin|dashboard)$/,
  /^(www|http|https)$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
]

/** Queries below this length carry no usable intent signal. */
export const MIN_SIGNAL_QUERY_LENGTH = 2

/** A single query longer than this is almost always a paste or a probe. */
export const MAX_SIGNAL_QUERY_LENGTH = 120

export const REQUEST_STATUSES = Object.freeze([
  'open',
  'matched',
  'in_progress',
  'fulfilled',
  'cancelled',
  'expired',
])

export const REQUEST_URGENCIES = Object.freeze(['low', 'normal', 'high', 'urgent'])

export const INTERACTION_TYPES = Object.freeze([
  'search',
  'result_click',
  'business_view',
  'profile_contact',
  'request_created',
  'request_offer',
  'save',
  'zero_result_search',
])

export function isActionableQuery(raw) {
  if (typeof raw !== 'string') return false
  const value = raw.trim().toLowerCase()
  if (value.length < MIN_SIGNAL_QUERY_LENGTH) return false
  if (value.length > MAX_SIGNAL_QUERY_LENGTH) return false
  if (/^(https?:\/\/|www\.)\S+/i.test(raw.trim())) return false
  return !NON_DEMAND_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Splits a raw query into the tokens the normaliser and the demand engine work
 * with. Kept here, in core, because both the search engine and the demand
 * engine need to agree on what a "term" is, and a second implementation of
 * tokenisation is a second, silently different definition of demand.
 */
export function tokenise(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[-']+|[-']+$/g, ''))
    .filter((token) => token.length > 0)
}

/**
 * Tokens that describe the query's shape rather than its content. They are kept
 * for search but excluded from demand aggregation, so "laptop repair near me"
 * contributes "laptop repair" to the demand signal and not "near me".
 */
const STOP_TOKENS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'on', 'for', 'to', 'from',
  'with', 'by', 'near', 'me', 'my', 'i', 'we', 'us', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'need', 'needs', 'want', 'wants', 'looking', 'look', 'find', 'finds',
  'best', 'good', 'cheap', 'cheapest', 'price', 'prices', 'cost', 'costs',
  'shop', 'shops', 'store', 'stores', 'buy', 'sell', 'please', 'help',
])

export function isStopToken(token) {
  return STOP_TOKENS.has(token)
}

/** Tokens that represent genuine demand intent. */
export function demandTokens(raw) {
  return tokenise(raw).filter((token) => !isStopToken(token))
}

/**
 * Combinations of adjacent demand tokens. "laptop repair" is a far stronger
 * demand signal than the unigram "laptop", which is dominated by product
 * browsing. Bigrams are what make the gap engine able to say "nobody in
 * Entebbe offers laptop screen repair" rather than "nobody sells laptops".
 */
export function demandPhrases(raw, maxLength = 3) {
  const tokens = demandTokens(raw)
  const phrases = new Set()
  for (let size = 2; size <= maxLength; size += 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      phrases.add(tokens.slice(i, i + size).join(' '))
    }
  }
  return [...phrases]
}

export function assertRequestStatus(status) {
  if (!REQUEST_STATUSES.includes(status)) {
    throw new ValidationError(`Unknown request status "${status}".`, {
      allowed: REQUEST_STATUSES,
    })
  }
  return status
}

export function assertUrgency(urgency) {
  if (!REQUEST_URGENCIES.includes(urgency)) {
    throw new ValidationError(`Unknown urgency "${urgency}".`, {
      allowed: REQUEST_URGENCIES,
    })
  }
  return urgency
}

export function assertInteractionType(type) {
  if (!INTERACTION_TYPES.includes(type)) {
    throw new ValidationError(`Unknown interaction type "${type}".`, {
      allowed: INTERACTION_TYPES,
    })
  }
  return type
}

/**
 * Classifies result quality. This is the single most important derived value
 * in the platform: a search that returned three results, none of them in the
 * area the person asked about, is a gap signal far stronger than a search that
 * simply returned nothing.
 */
export function classifyResultQuality({ totalResults, inAreaResults = null }) {
  const relevant = inAreaResults ?? totalResults
  if (totalResults === 0) return 'zero'
  if (relevant === 0) return 'none_in_area'
  if (relevant === 1) return 'single'
  if (relevant <= 3) return 'thin'
  return 'healthy'
}

export const RESULT_QUALITY_ORDER = Object.freeze([
  'zero',
  'none_in_area',
  'single',
  'thin',
  'healthy',
])
