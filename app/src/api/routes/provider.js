import { single, paged, toPage, uuidPattern, idParamSchema } from '../lib/http.js'
import { ForbiddenError, NotFoundError } from '../../core/errors.js'
import { publicReview } from '../../core/reviews.js'
import {
  buildPhotoUpload,
  publicPhoto,
  CAPTION_MAX,
  ALT_TEXT_MAX,
} from '../../core/photos.js'
import { newId } from '../../core/identifiers.js'
import {
  PRODUCT_CONDITIONS,
  PRODUCT_STATUSES,
  CONTACT_KINDS,
} from '../../core/business.js'

/**
 * The provider desk.
 *
 * A provider is somebody who owns listings, not a member of staff, so every
 * route here is scoped twice: authentication plus the `provider:write`
 * capability, and then a per-listing ownership check against the claims table.
 * The capability alone is deliberately not enough to read any listing — a
 * provider's whole trust is "these listings, and no others".
 *
 * The reachable surface is also narrower than an editor's. A provider may edit
 * the words that describe their business, add contact points, and maintain their
 * services and products. They may not rename the business, move it to another
 * category or location, change its status or review state, or touch its
 * capability level. Those are decisions about what the directory is, not about
 * what the owner is selling, and the platform does not delegate them to the
 * person with an interest in the answer. `businesses.update` refuses to change
 * review state at all; the route narrows it further by only ever passing the
 * three fields below.
 */

const CONSUMER_FIELDS = ['description', 'website', 'foundedYear']

const businessPatchSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    description: { type: 'string', maxLength: 4000 },
    website: { type: 'string', maxLength: 300 },
    foundedYear: { type: 'integer', minimum: 1800, maximum: 2100 },
  },
}

const contactBodySchema = {
  type: 'object',
  required: ['kind', 'value'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...CONTACT_KINDS] },
    value: { type: 'string', minLength: 3, maxLength: 300 },
    isPrimary: { type: 'boolean' },
  },
}

const contactPatchSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { isPublic: { type: 'boolean' }, isPrimary: { type: 'boolean' } },
}

const serviceBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    description: { type: 'string', maxLength: 2000 },
    categoryId: { type: 'string', pattern: uuidPattern },
    priceMin: { type: 'number', minimum: 0 },
    priceMax: { type: 'number', minimum: 0 },
    priceUnit: { type: 'string', maxLength: 40 },
    skills: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 80 }, maxItems: 20 },
    isActive: { type: 'boolean' },
  },
}

const productBodySchema = {
  type: 'object',
  required: ['name', 'condition'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    description: { type: 'string', maxLength: 2000 },
    categoryId: { type: 'string', pattern: uuidPattern },
    condition: { type: 'string', enum: [...PRODUCT_CONDITIONS] },
    quantity: { type: 'integer', minimum: 1, maximum: 100000 },
    priceMin: { type: 'number', minimum: 0 },
    priceMax: { type: 'number', minimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    isRecyclable: { type: 'boolean' },
    status: { type: 'string', enum: [...PRODUCT_STATUSES] },
  },
}

/**
 * The whole week, submitted at once.
 *
 * Opening hours are the one part of a listing a provider owns outright: it is a
 * fact about their day, not a decision about what the directory is, so unlike
 * the review state or the category this is theirs to set. The shape is the same
 * seven days whether the provider filled in one or all of them; a day left out
 * is closed.
 */
const hoursBodySchema = {
  type: 'object',
  required: ['week'],
  additionalProperties: false,
  properties: {
    week: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        required: ['weekday'],
        additionalProperties: false,
        properties: {
          weekday: { type: 'integer', minimum: 1, maximum: 7 },
          isClosed: { type: 'boolean' },
          opens: { type: 'string', maxLength: 5 },
          closes: { type: 'string', maxLength: 5 },
        },
      },
    },
  },
}

const childParamsSchema = (child) => ({
  type: 'object',
  required: ['id', child],
  properties: { id: idParamSchema.properties.id, [child]: idParamSchema.properties.id },
})

/**
 * A photo upload.
 *
 * The image travels as a base64 data url rather than a multipart body, because
 * that is the one upload form fastify can accept without a second parser plugin,
 * and a data url is exactly what a browser's FileReader produces with no
 * dependency at all. `data` carries the whole string; the stage decodes it into
 * bytes and reads the real format from the bytes, so nothing here trusts the
 * prefix.
 *
 * The length ceiling is generous on purpose: the transport limit
 * (config.api.photoBodyLimit) is what actually refuses an oversized request, and
 * this is a backstop that answers 400 rather than a parse failure.
 */
const photoBodySchema = {
  type: 'object',
  required: ['data'],
  additionalProperties: false,
  properties: {
    data: { type: 'string', minLength: 32, maxLength: 8 * 1024 * 1024 },
    caption: { type: 'string', maxLength: CAPTION_MAX },
    altText: { type: 'string', maxLength: ALT_TEXT_MAX },
  },
}

const photoPatchSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    caption: { type: ['string', 'null'], maxLength: CAPTION_MAX },
    altText: { type: ['string', 'null'], maxLength: ALT_TEXT_MAX },
    position: { type: 'integer', minimum: 0, maximum: 100000 },
  },
}

/** Trims a caption/alt value, treating an emptied field as "removed". */
function optionalText(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  return String(value).trim() || null
}

export default async function providerRoutes(fastify, { app, config, media }) {
  /** Refuses a listing that is not one of this caller's own. */
  function assertOwner(userId, businessId) {
    if (!app.claims.isOwner(userId, businessId)) {
      throw new ForbiddenError('You can only manage listings you have claimed.')
    }
  }

  /** Refuses unless the child row belongs to a business owned by the caller. */
  function assertOwnedChild(userId, businessId, childBusinessId) {
    if (!childBusinessId || childBusinessId !== businessId) {
      throw new NotFoundError('Record', childBusinessId ?? 'unknown')
    }
    assertOwner(userId, businessId)
  }

  const preHandler = fastify.requireCapability('provider:write')

  /**
   * The listings this provider owns.
   *
   * The starting point for the whole desk: a provider signs in knowing their own
   * business, and this tells the interface which listings that is without the
   * client having to guess or store an id.
   */
  fastify.get(
    '/provider/businesses',
    {
      schema: {
        summary: 'The listings you have claimed.',
        tags: ['provider'],
      },
      preHandler,
    },
    async (request) => {
      const items = app.claims.ownedBusinesses(request.user.id)
      return single(items, { count: items.length })
    },
  )

  fastify.get(
    '/provider/businesses/:id',
    {
      schema: {
        summary: 'One of your listings, with its private contact points.',
        tags: ['provider'],
        params: idParamSchema,
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      const business = app.businesses.findById(request.params.id)
      if (!business) throw new NotFoundError('Business', request.params.id)
      return single(app.businesses.profile(business.id, { includePrivateContacts: true }))
    },
  )

  /**
   * Edit the descriptive fields of your own listing.
   *
   * Narrow on purpose. Only the words that describe what the business is reach
   * the repository, so a crafted body naming `name`, `categoryId`, `status` or
   * `capabilityLevel` cannot smuggle a change past the schema.
   */
  fastify.patch(
    '/provider/businesses/:id',
    {
      schema: {
        summary: 'Update your listing\'s description, website and founding year.',
        tags: ['provider'],
        params: idParamSchema,
        body: businessPatchSchema,
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      const patch = {}
      for (const field of CONSUMER_FIELDS) {
        if (request.body[field] !== undefined) patch[field] = request.body[field]
      }
      const before = app.businesses.requireById(request.params.id)
      const updated = app.businesses.update(request.params.id, patch)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'provider.business.update',
        entityType: 'business',
        entityId: updated.id,
        before,
        after: updated,
      })
      return single(updated)
    },
  )

  /* Contacts ---------------------------------------------------------------- */

  /**
   * Add a contact point.
   *
   * Provider-added contacts are public by default. The default hides a business's
   * own details from the very page it wants to be found on, which is the wrong
   * bias for the owner (an operator adding a scraped number is the opposite case,
   * and the admin route defaults it private for that reason).
   */
  fastify.post(
    '/provider/businesses/:id/contacts',
    {
      schema: {
        summary: 'Add a contact point to your listing.',
        tags: ['provider'],
        params: idParamSchema,
        body: contactBodySchema,
      },
      preHandler,
    },
    async (request, reply) => {
      assertOwner(request.user.id, request.params.id)
      const contact = app.businesses.addContact(request.params.id, {
        ...request.body,
        isPublic: true,
      })
      return reply.status(201).send(single(contact))
    },
  )

  fastify.patch(
    '/provider/businesses/:id/contacts/:contactId',
    {
      schema: {
        summary: 'Publish, unpublish or re-rank one of your contact points.',
        tags: ['provider'],
        params: childParamsSchema('contactId'),
        body: contactPatchSchema,
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.contactBusinessId(request.params.contactId),
      )
      return single(
        app.businesses.setContactVisibility(request.params.contactId, request.body),
      )
    },
  )

  fastify.delete(
    '/provider/businesses/:id/contacts/:contactId',
    {
      schema: {
        summary: 'Remove one of your contact points.',
        tags: ['provider'],
        params: childParamsSchema('contactId'),
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.contactBusinessId(request.params.contactId),
      )
      return single({ removed: app.businesses.removeContact(request.params.contactId) })
    },
  )

  /* Services ---------------------------------------------------------------- */

  fastify.post(
    '/provider/businesses/:id/services',
    {
      schema: {
        summary: 'Add a service to your listing.',
        tags: ['provider'],
        params: idParamSchema,
        body: serviceBodySchema,
      },
      preHandler,
    },
    async (request, reply) => {
      assertOwner(request.user.id, request.params.id)
      const service = app.businesses.addService(request.params.id, request.body)
      return reply.status(201).send(single(service))
    },
  )

  fastify.patch(
    '/provider/businesses/:id/services/:serviceId',
    {
      schema: {
        summary: 'Update one of your services.',
        tags: ['provider'],
        params: childParamsSchema('serviceId'),
        body: { type: 'object', minProperties: 1, properties: serviceBodySchema.properties },
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.serviceBusinessId(request.params.serviceId),
      )
      return single(app.businesses.updateService(request.params.serviceId, request.body))
    },
  )

  fastify.delete(
    '/provider/businesses/:id/services/:serviceId',
    {
      schema: {
        summary: 'Remove one of your services.',
        tags: ['provider'],
        params: childParamsSchema('serviceId'),
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.serviceBusinessId(request.params.serviceId),
      )
      return single({ removed: app.businesses.removeService(request.params.serviceId) })
    },
  )

  /* Products ---------------------------------------------------------------- */

  fastify.post(
    '/provider/businesses/:id/products',
    {
      schema: {
        summary: 'Add a product to your listing.',
        tags: ['provider'],
        params: idParamSchema,
        body: productBodySchema,
      },
      preHandler,
    },
    async (request, reply) => {
      assertOwner(request.user.id, request.params.id)
      const product = app.businesses.addProduct(request.params.id, request.body)
      return reply.status(201).send(single(product))
    },
  )

  fastify.patch(
    '/provider/businesses/:id/products/:productId',
    {
      schema: {
        summary: 'Update one of your products.',
        tags: ['provider'],
        params: childParamsSchema('productId'),
        body: { type: 'object', minProperties: 1, properties: productBodySchema.properties },
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.productBusinessId(request.params.productId),
      )
      return single(app.businesses.updateProduct(request.params.productId, request.body))
    },
  )

  fastify.delete(
    '/provider/businesses/:id/products/:productId',
    {
      schema: {
        summary: 'Remove one of your products.',
        tags: ['provider'],
        params: childParamsSchema('productId'),
      },
      preHandler,
    },
    async (request) => {
      assertOwnedChild(
        request.user.id,
        request.params.id,
        app.claims.productBusinessId(request.params.productId),
      )
      return single({ removed: app.businesses.removeProduct(request.params.productId) })
    },
  )

  /* Opening hours ----------------------------------------------------------- */

  fastify.put(
    '/provider/businesses/:id/hours',
    {
      schema: {
        summary: "Replace your listing's weekly opening hours.",
        tags: ['provider'],
        params: idParamSchema,
        body: hoursBodySchema,
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      return single({ hours: app.businesses.setHours(request.params.id, request.body.week) })
    },
  )

  fastify.delete(
    '/provider/businesses/:id/hours',
    {
      schema: {
        summary: 'Remove your listing\'s opening hours.',
        tags: ['provider'],
        params: idParamSchema,
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      return single({ hours: app.businesses.clearHours(request.params.id) })
    },
  )

  /* Reviews ------------------------------------------------------------------ */

  /**
   * What people have said about your listing.
   *
   * The owner sees pending reviews as well as published ones, because the owner
   * is the person most likely to spot a review that is really about a different
   * shop and the least able to do anything about it if it appears without
   * warning. The pending rows are marked by their `status`; the payload is the
   * public shape, so the site's own moderation note never leaves the desk.
   */
  fastify.get(
    '/provider/businesses/:id/reviews',
    {
      schema: {
        summary: 'Reviews for one of your listings, including ones awaiting moderation.',
        tags: ['provider'],
        params: idParamSchema,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'published', 'rejected'] },
            sort: { type: 'string', enum: ['newest', 'oldest', 'rating'] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      const page = toPage(request.query)
      const result = app.reviews.list({
        businessId: request.params.id,
        status: request.query.status ?? null,
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      result.items = result.items.map(publicReview)
      return paged(result, { ...page, rating: app.reviews.summaryFor(request.params.id) })
    },
  )

  /* Photos ------------------------------------------------------------------- */

  /** The url at which a photo's bytes are served, for the interface to point at. */
  function contentUrl(photoId) {
    return `${config.api.prefix}/photos/${photoId}/content`
  }

  /**
   * A photo with the url the client renders, and the private path stripped.
   *
   * `moderationReason` is put back for the owner: it is dropped by `publicPhoto`
   * because the public must not read the operator's notes, but the owner is the
   * one who has to act on a rejection, so they are the one caller who needs it.
   */
  function withUrl(photo) {
    return {
      ...publicPhoto(photo),
      url: contentUrl(photo.id),
      moderationReason: photo.moderationReason ?? null,
    }
  }

  /**
   * Refuses a photo that is not on one of this caller's own listings.
   *
   * The ownership check is on the listing, not the photo: the id in the path is
   * the business the caller is acting on, and the photo has to belong to that
   * same business or the request is for something the caller does not own.
   */
  function ownedPhoto(userId, businessId, photoId) {
    const photo = app.photos.requireById(photoId)
    if (photo.businessId !== businessId) throw new NotFoundError('Photo', photoId)
    assertOwner(userId, businessId)
    return photo
  }

  /**
   * The gallery as its owner sees it, pending photos included.
   *
   * The owner is the person who needs to know a picture is waiting on the
   * moderator, so unlike the public list this returns every status and marks it.
   */
  fastify.get(
    '/provider/businesses/:id/photos',
    {
      schema: {
        summary: 'Photos for one of your listings, including ones awaiting moderation.',
        tags: ['provider'],
        params: idParamSchema,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'published', 'rejected'] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler,
    },
    async (request) => {
      assertOwner(request.user.id, request.params.id)
      const page = toPage(request.query)
      const result = app.photos.list({
        businessId: request.params.id,
        status: request.query.status ?? null,
        sort: 'newest',
        ...page,
      })
      result.items = result.items.map(withUrl)
      return paged(result, page)
    },
  )

  /**
   * Upload a photo to your own listing.
   *
   * The file is written before the row, and the file is removed again if the row
   * cannot be written. The other order would leave a row pointing at bytes that
   * were never stored, which is worse than an orphaned file a sweep can find: a
   * row is something the gallery links to.
   */
  fastify.post(
    '/provider/businesses/:id/photos',
    {
      schema: {
        summary: 'Upload a photo to one of your listings. It is held for moderation.',
        tags: ['provider'],
        params: idParamSchema,
        body: photoBodySchema,
      },
      // Raised on this route alone. Every other request is still refused at the
      // small global limit, so the larger ceiling is not a hole in the api.
      bodyLimit: config.api.photoBodyLimit,
      preHandler: [preHandler, fastify.enforceRateLimit('photo')],
    },
    async (request, reply) => {
      assertOwner(request.user.id, request.params.id)
      const upload = buildPhotoUpload(request.body)
      const storageKey = `${newId()}.${upload.extension}`
      media.write(storageKey, upload.bytes)

      let photo
      try {
        photo = app.photos.create({
          businessId: request.params.id,
          storageKey,
          mimeType: upload.mimeType,
          byteSize: upload.bytes.length,
          caption: upload.caption,
          altText: upload.altText,
          source: 'provider',
          uploadedBy: request.user.id,
        })
      } catch (error) {
        media.remove(storageKey)
        throw error
      }
      return reply.status(201).send(single(withUrl(photo), { moderation: 'pending' }))
    },
  )

  /** Reword or reorder one of your photos. Cannot change its moderation status. */
  fastify.patch(
    '/provider/businesses/:id/photos/:photoId',
    {
      schema: {
        summary: "Update a photo's caption, alt text or position.",
        tags: ['provider'],
        params: childParamsSchema('photoId'),
        body: photoPatchSchema,
      },
      preHandler,
    },
    async (request) => {
      ownedPhoto(request.user.id, request.params.id, request.params.photoId)
      return single(
        withUrl(
          app.photos.update(request.params.photoId, {
            caption: optionalText(request.body.caption),
            altText: optionalText(request.body.altText),
            position: request.body.position,
          }),
        ),
      )
    },
  )

  /** Remove one of your photos, and its bytes with it. */
  fastify.delete(
    '/provider/businesses/:id/photos/:photoId',
    {
      schema: {
        summary: 'Remove one of your photos.',
        tags: ['provider'],
        params: childParamsSchema('photoId'),
      },
      preHandler,
    },
    async (request) => {
      ownedPhoto(request.user.id, request.params.id, request.params.photoId)
      const removed = app.photos.remove(request.params.photoId)
      media.remove(removed.storageKey)
      return single({ removed: true })
    },
  )
}
