import { paged, single, toPage, toText, uuidPattern, idParamSchema } from '../lib/http.js'
import { DECISION_NAMES, CLAIM_STATUSES } from '../../core/claims.js'
import { NotFoundError, ValidationError } from '../../core/errors.js'

/**
 * Claiming a listing.
 *
 * The public half of the flow, and the review half, in one module because they
 * are two ends of the same record and the transition rules have to be read
 * together to mean anything.
 *
 * The public write is limited like a marketplace request rather than a read:
 * anything a member of the public can post in bulk is a thing a script will post
 * in bulk. Reading a claim's own status is a read, but the reference doubles as
 * the lookup key, so it is not a channel for enumerating the directory: an
 * unknown reference is simply a 404, the same as a marketplace request.
 */

const referenceParamsSchema = {
  type: 'object',
  required: ['reference'],
  properties: { reference: { type: 'string', pattern: '^[A-Z0-9-]{6,24}$' } },
}

const claimBodySchema = {
  type: 'object',
  required: ['businessId', 'claimedAs', 'relation'],
  additionalProperties: false,
  properties: {
    businessId: { type: 'string', pattern: uuidPattern },
    claimedAs: { type: 'string', minLength: 2, maxLength: 160 },
    relation: { type: 'string', minLength: 2, maxLength: 240 },
    contactEmail: { type: 'string', maxLength: 254 },
    contactPhone: { type: 'string', maxLength: 40 },
    evidence: { type: 'string', maxLength: 2000 },
  },
}

/**
 * A claim as its claimant sees it.
 *
 * The public shape is deliberately thin: the business is named, and nothing about
 * the review internals or the claimant's own private evidence is shown without
 * proof of ownership. `reason` is only ever the operator's decision, which the
 * claimant is entitled to read once there is one.
 */
function publicClaimView(claim, { business, includePrivate = false } = {}) {
  const view = {
    reference: claim.reference,
    status: claim.status,
    claimedAs: claim.claimedAs,
    relation: claim.relation,
    createdAt: claim.createdAt,
    decidedAt: claim.decidedAt,
    business: business
      ? { id: business.id, name: business.name, slug: business.slug }
      : claim.businessId
        ? { id: claim.businessId }
        : null,
  }
  if (claim.status === 'rejected' || claim.status === 'revoked') {
    view.reason = claim.reason
  }
  if (includePrivate) {
    view.contactEmail = claim.contactEmail
    view.contactPhone = claim.contactPhone
    view.evidence = claim.evidence
    view.matchesContact = claim.matchesContact
  }
  return view
}

export default async function claimRoutes(fastify, { app }) {
  const { businesses } = app

  /**
   * Claim a listing.
   *
   * Anonymous: the claimant has no account, which is the whole point. The
   * response carries the reference and a one-time access token, and nothing else
   * does.
   */
  fastify.post(
    '/claims',
    {
      schema: {
        summary: 'Claim a listing as its owner.',
        description:
          'Anonymous. A listing may hold at most one open claim. Keep the returned access token to withdraw it or follow it privately.',
        tags: ['claims'],
        body: claimBodySchema,
      },
      preHandler: fastify.enforceRateLimit('request'),
    },
    async (request, reply) => {
      const created = app.claims.create(request.body)
      reply.header('location', `${fastify.kip.config.api.prefix}/claims/${created.reference}`)
      return reply.status(201).send(
        single({
          reference: created.reference,
          status: created.status,
          // Returned exactly once, never readable from the row again.
          accessToken: created.accessToken,
          createdAt: created.createdAt,
        }),
      )
    },
  )

  /**
   * Follow a claim.
   *
   * Public by reference, like a marketplace request, with the claimant's own
   * evidence in the response only when they prove it: the token issued at
   * submission (sent as `x-claim-token`, so it never lands in a url or an access
   * log) or the session of the owner the claim was granted to.
   */
  fastify.get(
    '/claims/:reference',
    {
      schema: {
        summary: 'Follow a claim by its reference.',
        description:
          'Public status. Send the access token as `x-claim-token` to see your own contact details and evidence.',
        tags: ['claims'],
        params: referenceParamsSchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request, reply) => {
      const claim = app.claims.findByReference(request.params.reference)
      if (!claim) throw new NotFoundError('BusinessClaim', request.params.reference)

      const token = request.headers['x-claim-token']
      const ownsIt =
        (request.authenticated && request.user.id === claim.userId) ||
        (typeof token === 'string' && app.claims.verifyAccessToken(claim.id, token))

      if (ownsIt) reply.header('cache-control', 'no-store')

      const business = businesses.findById(claim.businessId)
      return single(publicClaimView(claim, { business, includePrivate: ownsIt }))
    },
  )

  /**
   * Withdraw a pending claim.
   *
   * Proven the same way as reading it privately: the token, or the owner's
   * session. The message is identical either way so the endpoint cannot be used
   * to discover which references exist.
   */
  fastify.post(
    '/claims/:reference/withdraw',
    {
      schema: {
        summary: 'Withdraw a claim you submitted.',
        tags: ['claims'],
        params: referenceParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { accessToken: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
      preHandler: fastify.enforceRateLimit('request'),
    },
    async (request) => {
      const claim = app.claims.findByReference(request.params.reference)
      const token = request.headers['x-claim-token'] ?? request.body?.accessToken
      const ownsIt =
        (request.authenticated && claim && request.user.id === claim.userId) ||
        (claim && typeof token === 'string' ? app.claims.verifyAccessToken(claim.id, token) : false)

      if (!ownsIt) {
        throw new ValidationError(
          'Provide the access token issued with this claim, or sign in as its owner.',
          { field: 'accessToken' },
        )
      }

      return single(app.claims.withdraw(claim.id))
    },
  )

  /* Review: the operator's half of the flow ---------------------------------- */

  fastify.get(
    '/admin/claims',
    {
      schema: {
        summary: 'Every claim, optionally filtered by status.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: [...CLAIM_STATUSES] },
            businessId: { type: 'string', pattern: uuidPattern },
            search: { type: 'string', maxLength: 120 },
            sort: { type: 'string', enum: ['newest', 'oldest', 'reference'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.claims.list({
        status: request.query.status ?? null,
        businessId: request.query.businessId ?? null,
        search: toText(request.query.search, { maxLength: 120 }),
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      return paged(result, { ...page, counts: app.claims.statusCounts() })
    },
  )

  fastify.get(
    '/admin/claims/:id',
    {
      schema: {
        summary: 'One claim with the listing it concerns.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => single(app.claims.detail(request.params.id)),
  )

  /**
   * Record a decision about a claim.
   *
   * Granting creates the owner's account, so it takes `user:write` as well as
   * `business:verify`: checking that a listing is real and agreeing to create a
   * login for whoever claimed it are different powers. Rejecting and revoking
   * only ever close a claim down, and either an editor or an admin may do them.
   */
  fastify.post(
    '/admin/claims/:id/decide',
    {
      schema: {
        summary: 'Grant, reject or revoke a claim.',
        description:
          'Granting creates a provider account for the claimant and issues a one-time password-reset token, which is returned once.',
        tags: ['admin'],
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: [...DECISION_NAMES] },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:verify'),
    },
    async (request) => {
      const { decision, reason } = request.body
      if (decision === 'grant' || decision === 'revoke') {
        await fastify.requireCapability('user:write')(request)
      }

      const before = app.claims.requireById(request.params.id)
      const result = app.claims.decide(request.params.id, {
        decision,
        reason: reason ?? null,
        actor: { id: request.user.id, role: request.user.role },
      })
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: `claim.${decision}`,
        entityType: 'business_claim',
        entityId: result.claim.id,
        reason: reason ?? null,
        before,
        after: result.claim,
      })

      return single({
        claim: result.claim,
        // Present only for a grant. The account is delivered by handing the owner
        // this token once, because nothing sends mail.
        owner: result.owner ?? null,
        passwordResetToken: result.passwordResetToken ?? null,
      })
    },
  )

  /**
   * A one-word sanity check used by the claim page: has this listing already been
   * claimed? Granting is refused for a listing with a granted claim, and the
   * public claim form should say so before somebody fills it in.
   */
  fastify.get(
    '/claims/status/:businessId',
    {
      schema: {
        summary: 'Whether a listing is open to a new claim.',
        tags: ['claims'],
        params: { type: 'object', required: ['businessId'], properties: { businessId: { type: 'string', pattern: uuidPattern } } },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const business = businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)
      const granted = app.claims.grantedForBusiness(business.id)
      const pending = app.claims.list({ businessId: business.id, status: 'pending', limit: 1 })
      const claimable = !granted && pending.total === 0
      return single({
        businessId: business.id,
        claimable,
        claimed: Boolean(granted),
        reason: granted
          ? 'This listing is already looked after by its owner.'
          : !claimable
            ? 'A claim for this listing is already being reviewed.'
            : null,
      })
    },
  )
}
