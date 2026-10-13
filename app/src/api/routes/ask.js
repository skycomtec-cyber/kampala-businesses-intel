import { paged, toPage } from '../lib/http.js'
import { actorForRequest } from '../lib/actor.js'
import { parseAsk } from '../../core/ask.js'

/**
 * Ask Kampala.
 *
 * One endpoint that answers a plain-language question by turning it into the same
 * query every other surface runs. It is deliberately built on the existing
 * engines and adds no new way of finding a business: `parseAsk` decides what was
 * asked, `search` or `businesses.list` answers it, and the demand engine records
 * it exactly as a search from the search box would be recorded.
 *
 * Two things this endpoint does that `/search` does not, and they are the whole
 * reason it exists:
 *
 *   - It reads the question, not the query string. "How many laptop repair
 *     businesses are there in Kampala?" resolves *laptop repair* to the taxonomy
 *     and *Kampala* to the geography, and answers with a number.
 *   - It says how it understood the question. `meta.understood` echoes the intent,
 *     the category and the location it matched, so an answer the engine got wrong
 *     is visible as a misreading rather than an empty result.
 *
 * Nothing leaves the machine. There is no model call here: the parsing is a
 * deterministic function in core/ask.js, which is what lets the same question be
 * replayed and audited.
 */

/**
 * The kinds of place a person actually names in a question.
 *
 * Not `country` (nobody asks "in Uganda" to mean a business down the road) and not
 * `cluster` (an informal grouping that is not a name people use). Bounded per
 * kind by the locations repository, which is enough for the Kampala metropolitan
 * set this platform covers.
 */
const NAMEABLE_KINDS = ['region', 'district', 'city', 'town', 'division', 'subcounty', 'ward']

export default async function askRoutes(fastify, { app }) {
  /**
   * `GET /ask?q=...`
   *
   * Rate limited with the search budget rather than the read budget, because every
   * question is a demand signal and the search budget is the one that reflects
   * that.
   */
  fastify.get(
    '/ask',
    {
      schema: {
        summary: 'Ask a question in plain language and get matching businesses, or a count.',
        description:
          'Answers locally and deterministically. The response explains how the question was understood in `meta.understood`.',
        tags: ['ask'],
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 300 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('search'),
    },
    async (request) => {
      const page = toPage(request.query, { defaultLimit: 25, maxLimit: 50 })
      const question = String(request.query.q)

      const plan = parseAsk(question, {
        categories: app.categories.all(),
        locations: loadNameableLocations(app),
      })

      const categoryId = plan.category?.id ?? null
      const locationId = plan.location?.id ?? null

      // A count question is answered by the same filter as a browse, with the page
      // size dropped to one: the number is the answer and the rows are not fetched.
      let result
      let matched
      if (plan.intent === 'count') {
        result = app.businesses.list({
          categoryId,
          locationId,
          search: plan.text || null,
          publishedOnly: true,
          includeSubtree: true,
          limit: 1,
          offset: 0,
        })
        matched = { items: [], total: result.total }
      } else if (plan.text) {
        matched = app.searchIndex.search({
          query: plan.text,
          locationId,
          categoryId,
          includeInactive: false,
          limit: page.limit,
          offset: page.offset,
        })
      } else {
        // Nothing left to search on, so the filters are the whole query. This is the
        // "how many electronics recyclers in Nakawa" case with no subject noun.
        matched = app.businesses.list({
          categoryId,
          locationId,
          publishedOnly: true,
          includeSubtree: true,
          limit: page.limit,
          offset: page.offset,
        })
      }

      // A question is demand, so it is recorded exactly as a search is: the same
      // pseudonymised actor, the same coverage resolution, the same retention. If
      // it were recorded differently the gap engine would be reading two different
      // definitions of what people asked for.
      const coverage = locationId
        ? app.locations.coverageLocation(locationId, app.locations.requireById(locationId).kind)
        : { locationId: null, coverageLevel: null }
      const { seed } = actorForRequest({ config: fastify.kip.config, request })
      app.demand.recordSearch({
        query: question,
        surface: 'web',
        locationId: coverage.locationId,
        coverageLevel: coverage.coverageLevel,
        categoryId,
        totalResults: matched.total,
        inAreaResults: locationId ? matched.total : null,
        actorSeed: seed,
      })

      const payload = paged(matched, plan.intent === 'count' ? { limit: 1, offset: 0 } : page)
      payload.meta.query = question
      payload.meta.intent = plan.intent
      payload.meta.understood = {
        text: plan.text || null,
        category: plan.category
          ? { id: plan.category.id, name: plan.category.name, slug: plan.category.slug }
          : null,
        location: plan.location
          ? {
              id: plan.location.id,
              name: plan.location.name,
              kind: plan.location.kind,
            }
          : null,
        categoryPhrase: plan.matched.categoryPhrase,
        locationPhrase: plan.matched.locationPhrase,
      }
      payload.meta.answer = describeAnswer(plan, matched.total)
      return payload
    },
  )
}

/** Every location whose name a person might type, across the nameable kinds. */
function loadNameableLocations(app) {
  const locations = []
  for (const kind of NAMEABLE_KINDS) {
    locations.push(...app.locations.byKind(kind))
  }
  return locations
}

/**
 * One sentence that says what was understood and what came back.
 *
 * Written on the server so the website, a phone app and a script all phrase the
 * same answer the same way, and so the explanation cannot drift from the
 * interpretation it is explaining.
 */
function describeAnswer(plan, total) {
  const subject = plan.category?.name ?? plan.text ?? 'businesses'
  const place = plan.location?.name
  if (plan.intent === 'count') {
    return place
      ? `${total} listing${total === 1 ? '' : 's'} for ${subject} in ${place}.`
      : `${total} listing${total === 1 ? '' : 's'} for ${subject}.`
  }
  if (total === 0) {
    return place
      ? `Nothing matched ${subject} in ${place}.`
      : `Nothing matched ${subject}.`
  }
  return place
    ? `Showing ${total} match${total === 1 ? '' : 'es'} for ${subject} in ${place}.`
    : `Showing ${total} match${total === 1 ? '' : 'es'} for ${subject}.`
}
