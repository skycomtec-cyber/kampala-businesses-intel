import { single, uuidPattern, idParamSchema } from '../lib/http.js'
import { ForbiddenError, NotFoundError } from '../../core/errors.js'
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

const childParamsSchema = (child) => ({
  type: 'object',
  required: ['id', child],
  properties: { id: idParamSchema.properties.id, [child]: idParamSchema.properties.id },
})

export default async function providerRoutes(fastify, { app }) {
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
}
