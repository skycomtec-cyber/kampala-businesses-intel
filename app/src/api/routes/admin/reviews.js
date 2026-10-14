import { paged, single, toPage, idParamSchema } from '../../lib/http.js'
import { REVIEW_STATUSES } from '../../../core/reviews.js'

/**
 * Admin: review moderation.
 *
 * The other half of the public review feature. A review arrives pending and sits
 * here until an operator publishes or rejects it; nothing a stranger types is
 * visible until then. The routes are deliberately thin — validate the shape,
 * check the capability, hand the decision to the repository, write the audit row
 * — because the rule that a review is only ever published by a recorded decision
 * lives in the repository, and a second copy in the api is how the two would
 * drift.
 *
 * A reason is required on every decision. Publishing is not a lesser act than
 * rejecting: it is the moment anonymous text becomes a statement the directory
 * makes about a business, and the note is the only record of who decided that and
 * why.
 */

const decisionBodySchema = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    // Both spellings are accepted because they read differently at the call site
    // and mean the same thing; `core/reviews.js` resolves whichever arrives.
    status: { type: 'string', enum: ['published', 'rejected'] },
    decision: { type: 'string', enum: ['publish', 'reject'] },
    reason: { type: 'string', minLength: 3, maxLength: 500 },
  },
}

const queueQuerySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...REVIEW_STATUSES] },
    businessId: { type: 'string', pattern: idParamSchema.properties.id.pattern },
    sort: { type: 'string', enum: ['newest', 'oldest', 'rating'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

export default async function adminReviewRoutes(fastify, { app }) {
  fastify.get(
    '/admin/reviews',
    {
      schema: {
        summary: 'The review moderation queue. Defaults to pending first.',
        tags: ['admin'],
        querystring: queueQuerySchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.reviews.list({
        businessId: request.query.businessId ?? null,
        // Default to the queue that needs a decision. A moderator opening this
        // screen is asking "what needs me", and everything else is a lookup.
        status: request.query.status ?? 'pending',
        sort: request.query.sort ?? 'oldest',
        ...page,
      })
      return paged(result, { ...page, counts: app.reviews.counts() })
    },
  )

  fastify.patch(
    '/admin/reviews/:id',
    {
      schema: {
        summary: 'Publish or reject a review, recording the reason.',
        tags: ['admin'],
        params: idParamSchema,
        body: decisionBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.reviews.adminById(request.params.id)
      const updated = app.reviews.moderate(request.params.id, {
        status: request.body.status,
        decision: request.body.decision,
        reason: request.body.reason,
        reviewerId: request.user.id,
      })
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.review.moderate',
        entityType: 'business_review',
        entityId: updated.id,
        before,
        after: updated,
      })
      return single(updated)
    },
  )

  fastify.delete(
    '/admin/reviews/:id',
    {
      schema: {
        summary: 'Delete a review outright, for spam not worth keeping.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.reviews.adminById(request.params.id)
      const removed = app.reviews.remove(request.params.id)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.review.delete',
        entityType: 'business_review',
        entityId: request.params.id,
        before,
        after: null,
      })
      return single({ removed })
    },
  )
}
