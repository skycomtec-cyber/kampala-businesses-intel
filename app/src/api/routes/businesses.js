import { paged, single, toList, toPage, toText, uuidPattern } from '../lib/http.js'
import { actorForRequest } from '../lib/actor.js'
import { isPubliclyVisible } from '../../core/business.js'
import { CAPABILITY_LEVELS } from '../../core/taxonomy.js'
import { COVERAGE_LEVELS } from '../../core/location.js'
import { NotFoundError } from '../../core/errors.js'

/**
 * The public directory.
 *
 * Two access rules, and they are different on purpose:
 *
 *   - `/businesses` is a filtered listing for browsing. It is rate limited, cache
 *     friendly, and only ever returns publicly visible records.
 *   - `/search` is the same index, but it is a *demand signal* as well as a
 *     result set. It records the search, and a search that returns nothing in the
 *     area the person asked about is the platform's most valuable single piece of
 *     data. That is why they are separate endpoints and not one clever endpoint
 *     with a flag.
 *
 * Contact points are filtered by the repository, not here: an unpublished phone
 * number must stay private even if a caller asks for a profile directly.
 */

const listQuerySchema = {
  type: 'object',
  properties: {
    categoryId: { type: 'string', pattern: uuidPattern },
    locationId: { type: 'string', pattern: uuidPattern },
    skillId: { type: 'string', pattern: uuidPattern },
    status: { type: 'string' },
    verificationState: { type: 'string' },
    capabilityLevel: { type: 'string', enum: [...CAPABILITY_LEVELS] },
    search: { type: 'string', maxLength: 120 },
    sort: { type: 'string', enum: ['newest', 'oldest', 'updated', 'name', 'name desc', 'status', 'verification'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
}

export default async function businessRoutes(fastify, { app }) {
  fastify.get(
    '/businesses',
    {
      schema: {
        summary: 'Browse publicly visible businesses.',
        tags: ['businesses'],
        querystring: listQuerySchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.businesses.list({
        categoryId: request.query.categoryId ?? null,
        locationId: request.query.locationId ?? null,
        skillId: request.query.skillId ?? null,
        status: request.query.status ?? null,
        verificationState: request.query.verificationState ?? null,
        capabilityLevel: request.query.capabilityLevel ?? null,
        search: toText(request.query.search, { maxLength: 120 }),
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      return paged(result, page)
    },
  )

  /**
   * A single profile, addressed by id or slug.
   *
   * Slugs are what a public URL contains, so accepting both means the api does
   * not force a client to look an id up before it can render a link it was just
   * handed.
   */
  fastify.get(
    '/businesses/:idOrSlug',
    {
      schema: {
        summary: 'One business profile, with services, products, skills and public contacts.',
        tags: ['businesses'],
        params: {
          type: 'object',
          required: ['idOrSlug'],
          properties: { idOrSlug: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const { idOrSlug } = request.params
      const business = app.businesses.findById(idOrSlug) ?? app.businesses.findBySlug(idOrSlug)
      // The visibility rule lives in core/business.js, so the api cannot drift
      // from the one the search index and supply counts use.
      if (!business || !isPubliclyVisible(business)) {
        // 404 rather than 403: a draft or rejected listing must be
        // indistinguishable from one that does not exist, or this endpoint becomes
        // a way to enumerate who has been delisted.
        throw new NotFoundError('Business', idOrSlug)
      }
      // `includePrivateContacts` is deliberately not a query parameter. Only the
      // admin routes can see unpublished contact points.
      return single(app.businesses.profile(business.id, { includePrivateContacts: false }))
    },
  )

  /**
   * Search, and the demand record that goes with it.
   *
   * The interesting part is what is *not* returned: the raw query is stored in a
   * quarantined table and the actor is a daily pseudonym, so this endpoint can be
   * called by anyone, including a crawler, without the platform accumulating
   * anything it could be accused of holding against a person.
   */
  fastify.get(
    '/search',
    {
      schema: {
        summary: 'Full-text search across businesses, services and products, recording an anonymised demand signal.',
        tags: ['search'],
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            locationId: { type: 'string', pattern: uuidPattern },
            categoryId: { type: 'string', pattern: uuidPattern },
            skillId: { type: 'string', pattern: uuidPattern },
            coverageLevel: { type: 'string', enum: [...COVERAGE_LEVELS] },
            sourceTypes: {
              type: 'array',
              items: { type: 'string', enum: ['business', 'service', 'product'] },
            },
            surface: { type: 'string', enum: ['web', 'mobile', 'api', 'assistant'] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('search'),
    },
    async (request, reply) => {
      const page = toPage(request.query, { defaultLimit: 25, maxLimit: 50 })
      const locationId = request.query.locationId ?? null
      const query = String(request.query.q)

      const result = app.searchIndex.search({
        query,
        locationId,
        categoryId: request.query.categoryId ?? null,
        skillId: request.query.skillId ?? null,
        sourceTypes: toList(request.query.sourceTypes),
        limit: page.limit,
        offset: page.offset,
      })

      // A search scoped to a place is a statement about that place, so the demand
      // event records the coverage level it was resolved at. The default is the
      // location's own kind rather than a hardcoded level, because attributing a
      // Kampala ward search to "district" because that was the first enum value
      // would quietly put every ward's demand on the district row. A search with
      // no location records none, rather than defaulting to the country and
      // inflating every national number.
      const coverage = locationId
        ? app.locations.coverageLocation(
            locationId,
            request.query.coverageLevel ?? app.locations.requireById(locationId).kind,
          )
        : { locationId: null, coverageLevel: null }

      const { seed } = actorForRequest({ config: fastify.kip.config, request })
      const event = app.demand.recordSearch({
        query,
        surface: request.query.surface ?? 'web',
        locationId: coverage.locationId,
        coverageLevel: coverage.coverageLevel,
        categoryId: request.query.categoryId ?? null,
        totalResults: result.total,
        inAreaResults: locationId ? result.total : null,
        actorSeed: seed,
      })

      // Whether this search counted is a signal in itself, but it is not
      // something the caller needs, so it rides in a header rather than the body.
      if (event) reply.header('x-demand-signal', 'recorded')
      else reply.header('x-demand-signal', 'ignored')

      return paged(result, page)
    },
  )

  /**
   * A cheap, indexed check for a name, phone number or website.
   *
   * This exists because the most valuable thing an operator can do on the phone
   * is find out whether a business is already listed before spending twenty
   * minutes typing it in twice.
   */
  fastify.get(
    '/businesses/match',
    {
      schema: {
        summary: 'Find an existing business by name, phone or website, to avoid duplicate listings.',
        tags: ['businesses'],
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 120 },
            phone: { type: 'string', minLength: 6, maxLength: 32 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const phone = toText(request.query.phone, { maxLength: 32 })
      const term = toText(request.query.q, { maxLength: 120 })
      if (!phone && !term) {
        return single({ matchedOn: null, exact: null, candidates: [] })
      }

      // A phone number is the strongest possible match, so it is checked on its
      // own and returned as an exact hit or nothing.
      if (phone) {
        const exact = app.businesses.findByContact({ kind: 'phone', value: phone })
        return single({ matchedOn: 'phone', exact, candidates: [] })
      }

      return single({
        matchedOn: 'name',
        exact: null,
        candidates: app.businesses.list({ search: term, limit: 10 }).items,
      })
    },
  )
}
