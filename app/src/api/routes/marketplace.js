import { paged, single, toPage, toText, uuidPattern } from '../lib/http.js'
import { actorForRequest } from '../lib/actor.js'
import { NotFoundError, ValidationError } from '../../core/errors.js'
import { REQUEST_URGENCIES } from '../../core/demand.js'

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
   */
  fastify.get(
    '/requests/:reference',
    {
      schema: {
        summary: 'A request, its items, its offers and its status history.',
        tags: ['marketplace'],
        params: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string', pattern: '^[A-Z0-9-]{6,24}$' } },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const found = app.marketplace.findByReference(request.params.reference)
      if (!found) throw new NotFoundError('Request', request.params.reference)
      return single(app.marketplace.detail(found.id, { includePrivate: false }))
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
        params: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string', pattern: '^[A-Z0-9-]{6,24}$' } },
        },
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
}
