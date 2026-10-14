import { uuidPattern } from '../lib/http.js'
import { can } from '../../core/auth.js'
import { NotFoundError } from '../../core/errors.js'

/**
 * Photo bytes.
 *
 * One route serves the actual image, addressed by photo id rather than by the
 * path on disk, so the storage layout never appears in a url. The visibility
 * rule is the whole point of the file: a published photo is public, and anything
 * else is served only to a caller who is allowed to moderate it or owns the
 * listing it belongs to.
 *
 * An unpublished photo answered here is a 404, not a 403, for the same reason a
 * draft listing is: a photo that is waiting for a moderator must be
 * indistinguishable from one that does not exist, or this becomes a way to
 * enumerate what is sitting in the queue.
 */

export default async function photoRoutes(fastify, { app, media }) {
  fastify.get(
    '/photos/:photoId/content',
    {
      schema: {
        summary: 'A photo\'s image bytes, when the caller is allowed to see it.',
        tags: ['businesses'],
        params: {
          type: 'object',
          required: ['photoId'],
          properties: { photoId: { type: 'string', pattern: uuidPattern } },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request, reply) => {
      const photo = app.photos.requireById(request.params.photoId)

      const isModerator = request.authenticated
        ? can(request.user.role, 'business:read') ||
          app.claims.isOwner(request.user.id, photo.businessId)
        : false
      if (photo.status !== 'published' && !isModerator) {
        throw new NotFoundError('Photo', request.params.photoId)
      }

      const bytes = media.read(photo.storageKey)
      // The row and the file can disagree if the media directory was removed or a
      // backup was restored without it. A missing file is a missing photo.
      if (!bytes) throw new NotFoundError('Photo', request.params.photoId)

      // A published photo is immutable enough to cache hard; an unpublished one is
      // never cached, so a moderator previewing it does not keep a copy around
      // after the decision.
      reply.header(
        'cache-control',
        photo.status === 'published' ? 'public, max-age=3600' : 'no-store',
      )
      reply.type(photo.mimeType)
      return reply.send(bytes)
    },
  )
}
