import { tokenise, isStopToken } from './demand.js'

/**
 * Ask Kampala.
 *
 * A question typed in plain language — "where can I repair a laptop in Ntinda" —
 * is turned into a structured query over the same engine every other surface uses.
 * The whole point of this module is that it does so locally, deterministically and
 * without a model or a network call: nothing leaves the machine, and the same
 * question always produces the same plan, which is what makes an answer
 * explainable ("we read this as *laptop repair* in *Ntinda*") rather than a black
 * box that a directory operator has to take on faith.
 *
 * It is deliberately not a chatbot. It extracts three things and refuses to guess
 * at the rest:
 *
 *   - an intent: a question that asks "how many" wants a count, anything else
 *     wants matching businesses;
 *   - at most one location, matched against the real geography;
 *   - at most one category, matched against the real taxonomy;
 *   - whatever is left over as the free text, which is what full-text search is
 *     for.
 *
 * A phrase that is not in the vocabulary is not silently dropped: it stays in the
 * free text, so an unknown place narrows the search rather than being ignored.
 * That is the failure mode that matters — a directory that quietly answers a
 * narrower question than the one asked is worse than one that answers nothing.
 *
 * Vocabulary is passed in rather than read here, because this file is core: it has
 * no database, no clock and no network, and the caller supplies the categories and
 * locations it wants matched.
 */

export const ASK_INTENTS = Object.freeze(['find', 'count'])

/** A question opening like this is asking for a number, not a list. */
const COUNT_PATTERN = /^(how many|how much|count|number of|how numerous)\b/

/**
 * Words that carry no search meaning in a question.
 *
 * `core/demand.js` already declares the stop tokens for demand extraction, and
 * they are reused here so a question and a search agree on what a "term" is. The
 * extras are the scaffolding of a question — the parts that say it is a question
 * rather than what it is about.
 */
const ASK_STOPWORDS = new Set([
  'where', 'which', 'who', 'what', 'whom', 'whose', 'when', 'why', 'how',
  'many', 'much', 'number', 'list', 'show', 'tell', 'give', 'find', 'search',
  'business', 'businesses', 'shop', 'shops', 'store', 'stores', 'company',
  'companies', 'service', 'services', 'provider', 'providers', 'place', 'places',
  'around', 'within', 'there', 'here', 'available', 'offer', 'offers', 'offering',
  'do', 'does', 'sell', 'sells', 'get', 'buy',
])

function isAskStopword(token) {
  return isStopToken(token) || ASK_STOPWORDS.has(token)
}

/**
 * The phrases a candidate can be recognised by.
 *
 * The full name and the slug spelled out as words, because people type both
 * "Kampala Central Division" and "kampala-central-division". Short fragments are
 * dropped so a one-letter location cannot swallow the question.
 */
function phrasesFor(candidate) {
  const phrases = new Set()
  const name = String(candidate.name ?? '').toLowerCase().trim()
  if (name) phrases.add(name)
  const fromSlug = String(candidate.slug ?? '').replace(/-/g, ' ').toLowerCase().trim()
  if (fromSlug) phrases.add(fromSlug)
  return [...phrases].filter((phrase) => phrase.replace(/\s+/g, '').length >= 3)
}

const BOUNDARY = /[^a-z0-9]/

/** Whether `phrase` occurs in `haystack` as a whole word (or words), not inside one. */
function occursAsWord(haystack, phrase) {
  let from = 0
  for (;;) {
    const index = haystack.indexOf(phrase, from)
    if (index === -1) return false
    const before = index === 0 ? ' ' : haystack[index - 1]
    const afterIndex = index + phrase.length
    const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex]
    if (BOUNDARY.test(before) && BOUNDARY.test(after)) return true
    from = index + 1
  }
}

/**
 * The longest candidate phrase contained in the question.
 *
 * Longest rather than first, because "Kampala Central Division" contains
 * "Kampala", and a question that named the division is asking about the division.
 */
function bestMatch(haystack, candidates) {
  let best = null
  for (const candidate of candidates) {
    for (const phrase of phrasesFor(candidate)) {
      if (!occursAsWord(haystack, phrase)) continue
      if (!best || phrase.length > best.phrase.length) {
        best = { candidate, phrase }
      }
    }
  }
  return best
}

/**
 * Turns a question into a plan.
 *
 * @param {string} question
 * @param {object} [vocabulary]
 * @param {Array<{id:string,name:string,slug:string}>} [vocabulary.categories]
 * @param {Array<{id:string,name:string,slug:string,kind:string}>} [vocabulary.locations]
 * @returns {{
 *   question: string, intent: string, text: string,
 *   category: object|null, location: object|null,
 *   matched: { categoryPhrase: string|null, locationPhrase: string|null },
 *   tokens: string[]
 * }}
 */
export function parseAsk(question, { categories = [], locations = [] } = {}) {
  const raw = String(question ?? '').trim()
  const normalised = raw.toLowerCase()
  const tokens = tokenise(raw)

  const intent = COUNT_PATTERN.test(normalised) ? 'count' : 'find'

  const categoryMatch = bestMatch(normalised, categories)
  const locationMatch = bestMatch(normalised, locations)

  // The words consumed by the recognised names are removed from the free text, so
  // a search for "laptop repair in Ntinda" does not also ask full-text for
  // "ntinda" and answer with everything that merely mentions the place.
  const consumed = new Set()
  for (const match of [categoryMatch, locationMatch]) {
    if (!match) continue
    for (const token of tokenise(match.phrase)) consumed.add(token)
  }

  const text = tokens
    .filter((token) => !isAskStopword(token) && !consumed.has(token))
    .join(' ')

  return {
    question: raw,
    intent,
    text,
    category: categoryMatch ? categoryMatch.candidate : null,
    location: locationMatch ? locationMatch.candidate : null,
    matched: {
      categoryPhrase: categoryMatch ? categoryMatch.phrase : null,
      locationPhrase: locationMatch ? locationMatch.phrase : null,
    },
    tokens,
  }
}
