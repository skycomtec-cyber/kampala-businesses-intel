import { paged, single, toPage, idParamSchema } from '../../lib/http.js'
import { PHOTO_STATUSES, publicPhoto } from '../../../core/photos.js'

/**
 * Admin: photo moderation.
 *
 * The other half of the public gallery. A photo arrives pending and sits here
 * until an operator publishes or rejects it; nothing a provider uploads is on the
 * profile until then. The routes are thin for the same reason the review queue is:
 * the rule that only a recorded decision makes a photo public lives in the
 * repository, and a second copy here is how the two would drift.
 *
 * Deletion removes the file as well as the row. The audit entry is written first
 * against the row that is about to go, so the record of what was removed survives
 * the removal.
 */

const decisionBodySchema = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['published', 'rejected'] },
    decision: { type: 'string', enum: ['publish', 'reject'] },
    reason: { type: 'string', minLength: 3, maxLength: 500 },
  },
}

const queueQuerySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...PHOTO_STATUSES] },
    businessId: { type: 'string', pattern: idParamSchema.properties.id.pattern },
    sort: { type: 'string', enum: ['newest', 'oldest'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

export default async function adminPhotoRoutes(fastify, { app, media }) {
  fastify.get(
    '/admin/photos',
    {
      schema: {
        summary: 'The photo moderation queue. Defaults to pending first.',
        tags: ['admin'],
        querystring: queueQuerySchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.photos.list({
        businessId: request.query.businessId ?? null,
        status: request.query.status ?? 'pending',
        sort: request.query.sort ?? 'oldest',
        ...page,
      })
      return paged(result, { ...page, counts: app.photos.counts() })
    },
  )

  fastify.patch(
    '/admin/photos/:id',
    {
      schema: {
        summary: 'Publish or reject a photo.',
        tags: ['admin'],
        params: idParamSchema,
        body: decisionBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.photos.adminById(request.params.id)
      const updated = app.photos.moderate(request.params.id, {
        status: request.body.status,
        decision: request.body.decision,
        reason: request.body.reason,
        reviewerId: request.user.id,
      })
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.photo.moderate',
        entityType: 'business_photo',
        entityId: updated.id,
        before,
        after: updated,
      })
      return single(publicPhoto(updated))
    },
  )

  fastify.delete(
    '/admin/photos/:id',
    {
      schema: {
        summary: 'Delete a photo and its file outright.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.photos.adminById(request.params.id)
      const removed = app.photos.remove(request.params.id)
      media.remove(removed.storageKey)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.photo.delete',
        entityType: 'business_photo',
        entityId: request.params.id,
        before,
        after: null,
      })
      return single({ removed: true })
    },
  )
}
