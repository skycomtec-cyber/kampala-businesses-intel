import { paged, single, toBoolean, toList, toPage, toText, uuidPattern } from '../lib/http.js'
import { actorForRequest } from '../lib/actor.js'
import { isPubliclyVisible } from '../../core/business.js'
import { describeState } from '../../core/hours.js'
import { publicReview } from '../../core/reviews.js'
import { CAPABILITY_LEVELS } from '../../core/taxonomy.js'
import { COVERAGE_LEVELS } from '../../core/location.js'
import { NotFoundError } from '../../core/errors.js'

/**
 * The public directory.
 *
 * Two access rules, and they are different on purpose:
 *
 *   - `/businesses` is a filtered listing for browsing. It is rate limited, cache
 *     friendly, and only ever returns publicly visible records. Its category and
 *     location filters cover the whole subtree by default, because a branch and a
 *     district are the units a person browses by; `includeSubtree=false` asks for
 *     the node itself.
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
    capabilityLevel: { type: 'string', enum: [...CAPABILITY_LEVELS] },
    search: { type: 'string', maxLength: 120 },
    sort: { type: 'string', enum: ['newest', 'oldest', 'updated', 'name', 'name desc', 'status', 'verification', 'distance'] },
    includeSubtree: { type: 'boolean' },
    // "Near me": the caller's own point and how far around it to look. Supplying
    // one of lat/lng without the other is refused, because half a coordinate is
    // not a place.
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    radiusKm: { type: 'number', exclusiveMinimum: 0, maximum: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
  // A misspelled filter has to be refused. Silently ignoring it answers with the
  // whole set, which a caller reads as "nothing matched" and a client author
  // reads as "my filter worked", and neither of them is true.
  additionalProperties: false,
}

/**
 * A review as the public submits it.
 *
 * `author` and `email` are the names a person would recognise; `core/reviews.js`
 * also accepts `authorName` and `authorEmail`, but the public body keeps the
 * shorter form. Neither the status nor the source is reachable from here: a
 * submission is always pending and always from `web`, and a body that tried to
 * say otherwise is refused rather than quietly corrected.
 */
const reviewBodySchema = {
  type: 'object',
  required: ['rating', 'author'],
  additionalProperties: false,
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    title: { type: 'string', maxLength: 160 },
    body: { type: 'string', maxLength: 2000 },
    author: { type: 'string', minLength: 2, maxLength: 80 },
    email: { type: 'string', maxLength: 200 },
  },
}

const reviewsQuerySchema = {
  type: 'object',
  properties: {
    sort: { type: 'string', enum: ['newest', 'oldest', 'rating'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    offset: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const businessSlugParam = {
  type: 'object',
  required: ['idOrSlug'],
  properties: { idOrSlug: { type: 'string', minLength: 1, maxLength: 200 } },
}

export default async function businessRoutes(fastify, { app }) {
  /**
   * Resolves a public listing by id or slug, or 404s.
   *
   * The visibility rule lives in core/business.js, so the api cannot drift from
   * the one the search index and supply counts use. 404 rather than 403: a draft
   * or rejected listing must be indistinguishable from one that does not exist,
   * or this becomes a way to enumerate who has been delisted.
   */
  function requirePublicBusiness(idOrSlug) {
    const business = app.businesses.findById(idOrSlug) ?? app.businesses.findBySlug(idOrSlug)
    if (!business || !isPubliclyVisible(business)) {
      throw new NotFoundError('Business', idOrSlug)
    }
    return business
  }

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
        capabilityLevel: request.query.capabilityLevel ?? null,
        search: toText(request.query.search, { maxLength: 120 }),
        sort: request.query.sort ?? 'newest',
        // Set here rather than left to the repository default, because this route
        // is the public one and "publicly visible" is not a filter a caller gets
        // to supply. There is no `verificationState` parameter on this endpoint on
        // purpose: a public caller asking for a review state could only ever be
        // asking for records the public must not see.
        publishedOnly: true,
        /**
         * A category is a branch and a district contains wards, so the default here
         * is the subtree, which is what "list what is in Nakawa Division" means to
         * the person asking. It is still a parameter rather than a hardcoded
         * behaviour, because the exact-node query is the correct one for a caller
         * reconciling a single category against `/counts` without `includeSubtree`,
         * and a route that could not be asked for that would push the difference
         * onto every client.
         */
        includeSubtree: toBoolean(request.query.includeSubtree, 'includeSubtree') ?? true,
        // Passed straight through as numbers; the repository validates the pair
        // through core/geo.js, so the rule lives in one place rather than being
        // half-enforced by the schema and half by the query.
        lat: request.query.lat,
        lng: request.query.lng,
        radiusKm: request.query.radiusKm,
        ...page,
      })
      // The badge a directory row shows. Computed for the page rather than
      // stored on the row, from the same rule the profile uses, so a list and
      // the page it links to can never disagree about whether a shop is open.
      const now = new Date()
      for (const item of result.items ?? []) {
        item.openState = describeState(app.businesses.hours(item.id), now)
      }
      // The rating each row carries, in one query for the whole page. Only rows
      // with at least one published review get one, so a card without a rating
      // is a card whose business nobody has rated rather than one missing data.
      const summaries = app.reviews.summariesFor((result.items ?? []).map((item) => item.id))
      for (const item of result.items ?? []) {
        const rating = summaries.get(item.id)
        if (rating && rating.count > 0) item.rating = rating
      }
      // When the caller asked from a point, the centre and the radius ride in
      // `meta` so the page can say "within 3 km of you" without keeping its own
      // copy of what it sent.
      return paged(result, result.geo ? { ...page, geo: result.geo } : page)
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
        params: businessSlugParam,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const business = requirePublicBusiness(request.params.idOrSlug)
      // `includePrivateContacts` is deliberately not a query parameter. Only the
      // admin routes can see unpublished contact points.
      const profile = app.businesses.profile(business.id, { includePrivateContacts: false })
      // Whether the doors are open is computed here, at read time, from the
      // stored week and the current moment. It is derived rather than stored so
      // a listing is never wrong about being open: there is no cached flag to go
      // stale, and no job that has to run for the badge to change.
      // The rating is derived the same way, from the published reviews that exist
      // right now, so rejecting a review changes the number with no rollup to run.
      return single({
        ...profile,
        openState: describeState(profile.hours, new Date()),
        rating: app.reviews.summaryFor(business.id),
      })
    },
  )

  /**
   * A business's published reviews.
   *
   * The public only ever sees `published`. A pending review is absent, not
   * hidden with a flag, because the repository query itself filters on the
   * status — there is no path from this route to a review a moderator has not
   * put there.
   */
  fastify.get(
    '/businesses/:idOrSlug/reviews',
    {
      schema: {
        summary: "A business's published reviews, newest first.",
        tags: ['businesses'],
        params: businessSlugParam,
        querystring: reviewsQuerySchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const business = requirePublicBusiness(request.params.idOrSlug)
      const page = toPage(request.query, { defaultLimit: 10, maxLimit: 50 })
      const result = app.reviews.listPublished({
        businessId: business.id,
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      result.items = result.items.map(publicReview)
      return paged(result, { ...page, rating: app.reviews.summaryFor(business.id) })
    },
  )

  /**
   * Submit a review.
   *
   * No account, like a marketplace request: requiring one to say a shop was good
   * would mean collecting the addresses this platform deliberately does not hold.
   * The cost of that openness is that a submission is untrusted by default, so it
   * is created pending and rate limited, and the response says plainly that it is
   * waiting rather than implying it is already on the page.
   */
  fastify.post(
    '/businesses/:idOrSlug/reviews',
    {
      schema: {
        summary: 'Submit a review for a business. It is held for moderation.',
        tags: ['businesses'],
        params: businessSlugParam,
        body: reviewBodySchema,
      },
      preHandler: fastify.enforceRateLimit('review'),
    },
    async (request, reply) => {
      const business = requirePublicBusiness(request.params.idOrSlug)
      const review = app.reviews.create({
        businessId: business.id,
        source: 'web',
        ...request.body,
      })
      return reply.status(201).send(single(publicReview(review), { moderation: 'pending' }))
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
            // Only the surfaces a caller can honestly claim for itself. The
            // database also allows 'admin', 'import' and 'system', and those are
            // deliberately not offered here: this route is anonymous, so
            // accepting them would let anyone file demand under an attribution
            // the platform chose for itself. A value absent from the search_event
            // CHECK is a 500 rather than a 400, so this list has to stay a
            // subset of what the column allows - test/api.test.js reads the
            // constraint out of SQLite and fails if it ever stops being one.
            //
            // 'mobile' is not here because no mobile client exists yet. It gets
            // added in the same commit as the migration that widens the CHECK.
            surface: { type: 'string', enum: ['web', 'api'] },
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
        description:
          'Operator-only. Matching deliberately looks at records that are not published, ' +
          'because the duplicate it is looking for is usually one still sitting in the review ' +
          'queue, so this endpoint cannot be public.',
        tags: ['businesses'],
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 120 },
            phone: { type: 'string', minLength: 6, maxLength: 32 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:read'),
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
