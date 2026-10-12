import { paged, single, toInteger, toPage, toText, uuidPattern } from '../lib/http.js'
import { actorForRequest } from '../lib/actor.js'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js'
import { REQUEST_URGENCIES } from '../../core/demand.js'
import { isPubliclyVisible } from '../../core/business.js'

/**
 * The marketplace.
 *
 * This is the only part of the platform a member of the public can write to, so
 * it carries the most abuse risk and gets the tightest limits: five requests a
 * minute, applied before the body is parsed.
 *
 * A requester gets back a reference and, if they posted anonymously, an access
 * token. The reference is what they read out to a provider on the phone; the token
 * is what proves the request is theirs when they want to withdraw it. Neither is
 * guessable, and neither reveals anything about anybody else.
 *
 * The other half of the marketplace is the providers, and a provider is a
 * business rather than a person, so their writes are not anonymous: offering to
 * fulfil a request takes an operator session with `business:write` and names the
 * business being acted for. The two halves share one rule about visibility — an
 * offer is only worth making from a business the public can already see, because
 * an offer from an unpublished listing is one the requester is never shown.
 */

const requestItemSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    quantity: { type: 'integer', minimum: 1, maximum: 999 },
    conditionPreference: {
      type: 'string',
      enum: ['new', 'refurbished', 'used_good', 'used_fair', 'for_parts', 'any'],
    },
    skillId: { type: 'string', pattern: uuidPattern },
    notes: { type: 'string', maxLength: 500 },
  },
}

const requestBodySchema = {
  type: 'object',
  required: ['title', 'categoryId', 'locationId'],
  properties: {
    title: { type: 'string', minLength: 6, maxLength: 160 },
    description: { type: 'string', maxLength: 2000 },
    categoryId: { type: 'string', pattern: uuidPattern },
    locationId: { type: 'string', pattern: uuidPattern },
    urgency: { type: 'string', enum: [...REQUEST_URGENCIES] },
    budgetMin: { type: 'integer', minimum: 0 },
    budgetMax: { type: 'integer', minimum: 0 },
    wantedBy: { type: 'string', maxLength: 40 },
    // Second Life Electronics signals: a requester who will take a used or
    // refurbished unit is supplying the repair-and-resale market, and saying so
    // is worth more to the gap engine than the request text itself.
    acceptsUsed: { type: 'boolean' },
    acceptsRecycled: { type: 'boolean' },
    items: { type: 'array', items: requestItemSchema, maxItems: 20 },
  },
}

/**
 * The reference pattern, named once.
 *
 * A reference is quoted over the phone and typed back in, so it stays short and
 * loud (KMP-2026-00042); declaring the shape in one place is also what stops the
 * several routes that address a request from slowly disagreeing about it.
 */
const referenceParamsSchema = {
  type: 'object',
  required: ['reference'],
  properties: { reference: { type: 'string', pattern: '^[A-Z0-9-]{6,24}$' } },
}

const offerParamsSchema = {
  type: 'object',
  required: ['reference', 'offerId'],
  properties: {
    reference: { type: 'string', pattern: '^[A-Z0-9-]{6,24}$' },
    offerId: { type: 'string', pattern: uuidPattern },
  },
}

const businessIdParamsSchema = {
  type: 'object',
  required: ['businessId'],
  properties: { businessId: { type: 'string', pattern: uuidPattern } },
}

const offerBodySchema = {
  type: 'object',
  required: ['businessId'],
  additionalProperties: false,
  properties: {
    businessId: { type: 'string', pattern: uuidPattern },
    message: { type: 'string', maxLength: 2000 },
    price: { type: 'number', minimum: 0 },
  },
}

const offerTokenBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { accessToken: { type: 'string', minLength: 16, maxLength: 200 } },
}

export default async function marketplaceRoutes(fastify, { app }) {
  /**
   * Post a request.
   *
   * Anonymous by default, because the people who most need to ask for a repair
   * are exactly the people least likely to want an account. An account only
   * removes the need to keep the access token.
   */
  fastify.post(
    '/requests',
    {
      schema: {
        summary: 'Post a request that listed businesses can offer to fulfil.',
        description:
          'Anonymous by design. A signed-out caller gets a one-time access token back; keep it to manage the request later.',
        tags: ['marketplace'],
        body: requestBodySchema,
      },
      preHandler: fastify.enforceRateLimit('request'),
    },
    async (request, reply) => {
      const { seed } = actorForRequest({ config: fastify.kip.config, request })
      const created = app.marketplace.create({
        ...request.body,
        requesterBucket: seed,
        requesterUserId: request.user?.id ?? null,
      })

      reply.header('location', `${fastify.kip.config.api.prefix}/requests/${created.reference}`)
      return reply.status(201).send(
        single({
          reference: created.reference,
          status: created.status,
          urgency: created.urgency,
          // Null for a signed-in requester, who does not need one.
          accessToken: created.accessToken ?? null,
          createdAt: created.createdAt,
        }),
      )
    },
  )

  /**
   * Follow a request.
   *
   * The reference is public; offers are listed but their messages are not, and
   * the requester's contact details are not here at all. Enough to decide whether
   * to call, nothing more.
   *
   * The one exception is the requester reading their own request. They prove that
   * the same way they prove it to withdraw: the token issued at creation, sent as
   * `x-request-token` so it never lands in a url or an access log, or the session
   * of the requester who signed in. A caller who proves neither still gets the
   * public view, so this route never tells anyone which references exist.
   */
  fastify.get(
    '/requests/:reference',
    {
      schema: {
        summary: 'A request, its items, its offers and its status history.',
        description:
          'Public. Send the access token issued at creation as `x-request-token` to read your own request with offer messages included.',
        tags: ['marketplace'],
        params: referenceParamsSchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request, reply) => {
      const found = app.marketplace.findByReference(request.params.reference)
      if (!found) throw new NotFoundError('Request', request.params.reference)

      const token = request.headers['x-request-token']
      const ownsIt =
        (request.authenticated && request.user.id === found.requesterUserId) ||
        (typeof token === 'string' && app.marketplace.verifyAccessToken(found.id, token))

      // The owner's view carries the words of offers addressed to them, so it is
      // not a public document even though no session is behind it. The token is
      // not in `vary`, so a shared cache would key the two views to the same url
      // and could hand a stranger the private one; the private read is therefore
      // uncacheable, and only the public view keeps the short public cache.
      if (ownsIt) reply.header('cache-control', 'no-store')

      return single(app.marketplace.detail(found.id, { includePrivate: ownsIt }))
    },
  )

  /** The supply side: open work a provider can respond to. */
  fastify.get(
    '/requests',
    {
      schema: {
        summary: 'Browse requests, by default the open ones.',
        tags: ['marketplace'],
        querystring: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', pattern: uuidPattern },
            locationId: { type: 'string', pattern: uuidPattern },
            status: {
              type: 'string',
              enum: ['open', 'matched', 'in_progress', 'fulfilled', 'cancelled', 'expired'],
            },
            urgency: { type: 'string', enum: [...REQUEST_URGENCIES] },
            search: { type: 'string', maxLength: 120 },
            acceptsUsed: { type: 'boolean' },
            sort: { type: 'string', enum: ['newest', 'oldest', 'urgency', 'reference'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.marketplace.list({
        categoryId: request.query.categoryId ?? null,
        locationId: request.query.locationId ?? null,
        status: request.query.status ?? 'open',
        urgency: request.query.urgency ?? null,
        search: toText(request.query.search, { maxLength: 120 }),
        acceptsUsed:
          request.query.acceptsUsed === undefined ? null : request.query.acceptsUsed,
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      return paged(result, page)
    },
  )

  /**
   * Withdraw a request.
   *
   * Requires either the access token issued at creation or a signed-in requester.
   * The failure message is identical in both cases so the endpoint cannot be used
   * to discover which references exist.
   */
  fastify.post(
    '/requests/:reference/withdraw',
    {
      schema: {
        summary: 'Withdraw a request you posted.',
        tags: ['marketplace'],
        params: referenceParamsSchema,
        body: {
          type: 'object',
          properties: { accessToken: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
      preHandler: fastify.enforceRateLimit('request'),
    },
    async (request) => {
      const { reference } = request.params
      const found = app.marketplace.findByReference(reference)
      const ownsIt =
        (request.authenticated && request.user.id === found?.requesterUserId) ||
        (found && request.body?.accessToken
          ? app.marketplace.verifyAccessToken(found.id, request.body.accessToken)
          : false)

      if (!ownsIt) {
        throw new ValidationError(
          'Provide the access token issued with this request, or sign in as the requester.',
          { field: 'accessToken' },
        )
      }

      return single(
        app.marketplace.setStatus(found.id, 'cancelled', {
          actorId: request.user?.id ?? null,
          note: 'withdrawn by requester',
        }),
      )
    },
  )

  /* Offers: the provider's half of the marketplace --------------------------- */

  /**
   * Offer to fulfil a request.
   *
   * A provider is a business, not a person, so this write is not anonymous: it
   * takes an operator session with `business:write` and names the business being
   * acted for. The offer is only accepted from a business the public can already
   * see, because an offer from an unpublished listing is not shown on the request
   * at all, and accepting it here would create a row neither the requester nor
   * anybody else could ever act on — a silent write with no reader.
   */
  fastify.post(
    '/requests/:reference/offers',
    {
      schema: {
        summary: 'Offer to fulfil a request, as one of your published businesses.',
        description:
          'Requires an operator session. The business must be active and approved, because an offer from an unpublished listing is never shown.',
        tags: ['marketplace'],
        params: referenceParamsSchema,
        body: offerBodySchema,
      },
      // Authentication and capability first, so a signed-out caller is told to
      // sign in rather than being handed the anonymous write budget, then the
      // tight public limit, because this is still a public-facing write.
      preHandler: [
        fastify.requireCapability('business:write'),
        fastify.enforceRateLimit('request'),
      ],
    },
    async (request, reply) => {
      const found = app.marketplace.findByReference(request.params.reference)
      if (!found) throw new NotFoundError('Request', request.params.reference)

      const business = app.businesses.findById(request.body.businessId)
      if (!business) throw new NotFoundError('Business', request.body.businessId)
      if (!isPubliclyVisible(business)) {
        throw new ConflictError(
          'Only a published (active and approved) business can offer on a request.',
          {
            businessId: business.id,
            status: business.status,
            verificationState: business.verificationState,
          },
        )
      }

      const offer = app.marketplace.addOffer(found.id, business.id, {
        message: request.body.message ?? null,
        price: request.body.price ?? null,
      })
      reply.header('location', `${fastify.kip.config.api.prefix}/requests/${found.reference}`)
      return reply.status(201).send(single(offer))
    },
  )

  /**
   * Withdraw an offer.
   *
   * The provider's side of "changed my mind". The caller names the business the
   * offer was made for, so an offer can only be retracted by naming the business
   * that owns it — a mis-guessed offer id on the right request is refused rather
   * than silently applied to somebody else's bid.
   */
  fastify.post(
    '/requests/:reference/offers/:offerId/withdraw',
    {
      schema: {
        summary: 'Withdraw an offer as the business that made it.',
        tags: ['marketplace'],
        params: offerParamsSchema,
        body: {
          type: 'object',
          required: ['businessId'],
          additionalProperties: false,
          properties: { businessId: { type: 'string', pattern: uuidPattern } },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const found = app.marketplace.findByReference(request.params.reference)
      if (!found) throw new NotFoundError('Request', request.params.reference)

      const detail = app.marketplace.detail(found.id, { includePrivate: true })
      const offer = detail.offers.find((row) => row.id === request.params.offerId)
      if (!offer) throw new NotFoundError('RequestOffer', request.params.offerId)
      if (offer.businessId !== request.body.businessId) {
        throw new ForbiddenError('That offer belongs to a different business.')
      }

      return single(app.marketplace.setOfferStatus(offer.id, 'withdrawn'))
    },
  )

  /**
   * Accept an offer.
   *
   * Only the requester may do this, proven exactly the way withdrawing a request
   * is: an access token for an anonymous request, or the session of the requester
   * who signed in. Accepting is the moment demand becomes a transaction, so it is
   * also the moment every other offer on the request is declined, in one write.
   */
  fastify.post(
    '/requests/:reference/offers/:offerId/accept',
    {
      schema: {
        summary: 'Accept one offer on a request you posted.',
        tags: ['marketplace'],
        params: offerParamsSchema,
        body: offerTokenBodySchema,
      },
      preHandler: fastify.enforceRateLimit('request'),
    },
    async (request) => {
      const found = app.marketplace.findByReference(request.params.reference)
      if (!found) throw new NotFoundError('Request', request.params.reference)

      const ownsIt =
        (request.authenticated && request.user.id === found.requesterUserId) ||
        (request.body?.accessToken
          ? app.marketplace.verifyAccessToken(found.id, request.body.accessToken)
          : false)

      if (!ownsIt) {
        throw new ValidationError(
          'Provide the access token issued with this request, or sign in as the requester.',
          { field: 'accessToken' },
        )
      }

      // The offer has to belong to *this* request. `acceptOffer` addresses an
      // offer by its own id, so without this a caller who controls one request
      // could accept an offer made on somebody else's.
      const detail = app.marketplace.detail(found.id, { includePrivate: true })
      if (!detail.offers.some((offer) => offer.id === request.params.offerId)) {
        throw new NotFoundError('RequestOffer', request.params.offerId)
      }

      return single(
        app.marketplace.acceptOffer(request.params.offerId, {
          actorId: request.user?.id ?? null,
        }),
      )
    },
  )

  /**
   * What a provider actually asks: "what did I bid on, and what is left?"
   *
   * Both reads hang off the business the offer write acts for, and both are
   * operator reads rather than public ones, because they are stated from the
   * business's own point of view and name open work a business has not answered.
   */
  fastify.get(
    '/admin/businesses/:businessId/offers',
    {
      schema: {
        summary: 'The offers a business has made, newest first.',
        tags: ['admin'],
        params: businessIdParamsSchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const business = app.businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)
      const offers = app.marketplace.offersForBusiness(business.id)
      return single(offers, { businessId: business.id, count: offers.length })
    },
  )

  fastify.get(
    '/admin/businesses/:businessId/matching-requests',
    {
      schema: {
        summary: 'Open requests a business could still offer on, in one place.',
        tags: ['admin'],
        params: businessIdParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        },
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const business = app.businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)
      // Same category and same primary location as the business, which is the
      // repository's deliberately boring matcher: a surprising matcher is a
      // matcher nobody trusts.
      const matches = app.marketplace.matchingOpenRequests({
        businessId: business.id,
        categoryId: business.categoryId,
        locationId: business.primaryLocationId,
        limit: toInteger(request.query.limit, 'limit', { min: 1, max: 100 }) ?? 25,
      })
      return single(matches, { businessId: business.id, count: matches.length })
    },
  )
}
