import { paged, single, toPage, toText, uuidPattern, idParamSchema } from '../../lib/http.js'
import {
  BUSINESS_STATUSES,
  PRODUCT_CONDITIONS,
  CONTACT_KINDS,
} from '../../../core/business.js'
import { REVIEW_ACTIONS, REVIEW_STATES } from '../../../core/catalogue.js'
import { CAPABILITY_LEVELS } from '../../../core/taxonomy.js'

/**
 * Admin: the supply side of the platform.
 *
 * This is where a listing actually comes into being, and it is deliberately the
 * most boring code in the project. Every route is thin: validate the shape, check
 * a capability, hand the work to the repository. No business rule lives here,
 * because a rule that only runs in the admin api is a rule the public search
 * index and the supply counts will quietly disagree with.
 *
 * There is no public "claim your business" flow, and there is no admin route that
 * creates a published listing either. A listing is created into the queue and
 * reaches the directory by being reviewed, so the only way to publish is to
 * record a decision, and the only way to record a decision is to say which one
 * and why.
 */

/**
 * The decisions that need `business:publish` rather than `business:verify`.
 *
 * `approve` and `unapprove` are here because they change whether the public can
 * see a listing at all. `reject` is not, because rejecting only ever removes a
 * listing from public view, and an editor who can verify a listing is close
 * enough to the facts to be trusted with taking one back down.
 */
const PUBLISHING_ACTIONS = new Set(['approve', 'unapprove'])
const REVIEW_ACTION_NAMES = Object.freeze(
  Object.keys(REVIEW_ACTIONS).filter((name) => name !== 'import'),
)

const businessBodySchema = {
  type: 'object',
  required: ['name', 'categoryId', 'locationId'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    slug: { type: 'string', minLength: 2, maxLength: 160 },
    description: { type: 'string', maxLength: 4000 },
    categoryId: { type: 'string', pattern: uuidPattern },
    locationId: { type: 'string', pattern: uuidPattern },
    status: { type: 'string', enum: [...BUSINESS_STATUSES] },
    capabilityLevel: { type: 'string', enum: [...CAPABILITY_LEVELS] },
    website: { type: 'string', maxLength: 300 },
    foundedYear: { type: 'integer', minimum: 1800, maximum: 2100 },
    sourceId: { type: 'string', maxLength: 120 },
    isOpenSource: { type: 'boolean' },
    addressText: { type: 'string', maxLength: 300 },
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    /** Skill names, created on the fly. The vocabulary is an operator's call. */
    skills: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 80 }, maxItems: 20 },
  },
}

const serviceBodySchema = {
  type: 'object',
  required: ['name'],
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
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    description: { type: 'string', maxLength: 2000 },
    categoryId: { type: 'string', pattern: uuidPattern },
    condition: { type: 'string', enum: [...PRODUCT_CONDITIONS] },
    quantity: { type: 'integer', minimum: 1, maximum: 100000 },
    priceMin: { type: 'number', minimum: 0 },
    priceMax: { type: 'number', minimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    /** Recycled stock is the Second Life Electronics vertical, not a by-product. */
    isRecyclable: { type: 'boolean' },
    status: { type: 'string', enum: ['available', 'reserved', 'sold', 'hidden'] },
  },
}

const contactBodySchema = {
  type: 'object',
  required: ['kind', 'value'],
  properties: {
    kind: { type: 'string', enum: [...CONTACT_KINDS] },
    value: { type: 'string', minLength: 3, maxLength: 300 },
    label: { type: 'string', maxLength: 80 },
    isPrimary: { type: 'boolean' },
    // Defaulting to unpublished matters: a number added by an operator is a
    // number they have not yet checked belongs to this business.
    isPublic: { type: 'boolean' },
  },
}

export default async function adminBusinessRoutes(fastify, { app }) {
  /**
   * The admin listing is not the public one. It shows drafts, suspended and
   * rejected records and can filter by verification state, because an editor's
   * job is to move listings through those states and they cannot do that if the
   * ones they are working on are invisible to them.
   */
  fastify.get(
    '/admin/businesses',
    {
      schema: {
        summary: 'Every business, including drafts and rejected listings.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', pattern: uuidPattern },
            locationId: { type: 'string', pattern: uuidPattern },
            status: { type: 'string', enum: [...BUSINESS_STATUSES] },
            verificationState: { type: 'string', enum: [...REVIEW_STATES] },
            search: { type: 'string', maxLength: 120 },
            sort: {
              type: 'string',
              enum: ['newest', 'oldest', 'updated', 'name', 'name desc', 'status', 'verification'],
            },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          // Same reasoning as the public list: an unknown filter is answered, not
          // dropped. An operator who mistypes `verificationState` has to be told,
          // because the alternative is a queue that silently shows everything.
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      return paged(
        app.businesses.list({
          categoryId: request.query.categoryId ?? null,
          locationId: request.query.locationId ?? null,
          status: request.query.status ?? null,
          verificationState: request.query.verificationState ?? null,
          search: toText(request.query.search, { maxLength: 120 }),
          sort: request.query.sort ?? 'updated',
          includeContacts: true,
          ...page,
        }),
        page,
      )
    },
  )

  /**
   * The full admin profile, unpublished contact points included.
   *
   * The public profile route cannot be widened into this one by a query
   * parameter, because a parameter is something a client can forget to send and a
   * private phone number leaking into a public payload is not recoverable.
   */
  fastify.get(
    '/admin/businesses/:id',
    {
      schema: {
        summary: 'A business with unpublished contact points and its full history of edits.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) =>
      single(
        app.businesses.profile(request.params.id, { includePrivateContacts: true }),
      ),
  )

  fastify.post(
    '/admin/businesses',
    {
      schema: {
        summary: 'Create a business.',
        tags: ['admin'],
        body: businessBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request, reply) => {
      const created = app.businesses.create(request.body)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.create',
        entityType: 'business',
        entityId: created.id,
        after: created,
      })
      reply.header(
        'location',
        `${fastify.settings.api.prefix}/businesses/${created.slug}`,
      )
      return reply.status(201).send(single(created))
    },
  )

  fastify.patch(
    '/admin/businesses/:id',
    {
      schema: {
        summary: 'Update a business.',
        tags: ['admin'],
        params: idParamSchema,
        body: { type: 'object', minProperties: 1, properties: businessBodySchema.properties },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.businesses.requireById(request.params.id)
      const updated = app.businesses.update(request.params.id, request.body)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.update',
        entityType: 'business',
        entityId: updated.id,
        before,
        after: updated,
      })
      return single(updated)
    },
  )

  fastify.post(
    '/admin/businesses/:id/verification',
    {
      schema: {
        summary: 'Record one review decision about a listing.',
        description:
          'Review is a separate action from editing because it is a claim about reality: ' +
          'it should appear in the history on its own, with a reason, and be reversible on ' +
          'its own. The body names the decision (`action`) rather than the state it leaves ' +
          'the record in, because the decision is what was done and who did it, and a state ' +
          'cannot tell you whether anybody chose it or arrived in it.',
        tags: ['admin'],
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: [...REVIEW_ACTION_NAMES] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:verify'),
    },
    async (request) => {
      const { action, reason } = request.body
      // Publishing is the one decision that puts the platform's name on a
      // listing, so it is refused here rather than deeper in, where the error
      // would read as a pipeline problem instead of a permission one.
      if (PUBLISHING_ACTIONS.has(action)) {
        await fastify.requireCapability('business:publish')(request)
      }

      const before = app.businesses.requireById(request.params.id)
      const updated = app.businesses.review(request.params.id, {
        action,
        reason,
        actor: { id: request.user.id, role: request.user.role },
      })
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: `business.${action}`,
        entityType: 'business',
        entityId: updated.id,
        reason: reason ?? null,
        before,
        after: updated,
      })
      // The recorded events come back with the decision, so a client never has to
      // make a second call to find out what a reviewer actually did.
      return single({ ...updated, reviewEvents: app.catalogue.eventsFor(updated.id) })
    },
  )

  /**
   * The same decision, applied to a page of listings.
   *
   * An import is the only thing in this platform that creates listings in
   * hundreds, and every one of them arrives unverified and private, because
   * nobody has decided they are real. Reviewing them one POST at a time is the
   * difference between finishing a survey in an afternoon and not finishing it,
   * and the alternative is not care, it is operator fatigue, which is worse.
   *
   * Two deliberate limits. The reason is required, so a batch carries one claim
   * in the history that says what was decided and why rather than a hundred
   * entries with nothing in them. And the ids are capped, so one request cannot
   * quietly decide the entire directory: the batch is a page of a queue, not the
   * queue.
   *
   * An id whose transition is illegal is reported as refused rather than skipped
   * silently. A batch of a hundred where nine were refused has to be visible as
   * a batch of ninety-one, or the operator walks away believing the queue is
   * clear when it is not.
   *
   * Publishing a contact point stays a separate decision per contact. Approving a
   * listing makes the business visible; it does not make a phone number that
   * somebody typed off a shopfront visible, and this route does not change that.
   */
  fastify.post(
    '/admin/businesses/verification',
    {
      schema: {
        summary: 'Record one review decision for several listings.',
        description:
          'Applies the same action and reason to every id, and reports each outcome ' +
          'separately, including the ones the pipeline refused.',
        tags: ['admin'],
        body: {
          type: 'object',
          required: ['ids', 'action', 'reason'],
          additionalProperties: false,
          properties: {
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: { type: 'string', pattern: uuidPattern },
            },
            action: { type: 'string', enum: [...REVIEW_ACTION_NAMES] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:verify'),
    },
    async (request) => {
      const { ids, action, reason } = request.body
      if (PUBLISHING_ACTIONS.has(action)) {
        await fastify.requireCapability('business:publish')(request)
      }

      // The batch is one unit of work: every decision and every history entry it
      // produces land together or not at all. A halfway-applied batch would
      // leave listings whose state says one thing and whose history says
      // nothing, which is the one outcome worse than refusing the batch.
      const decide = app.db.transaction(() => {
        const rows = []
        const counts = { updated: 0, unchanged: 0, refused: 0, missing: 0 }

        for (const id of ids) {
          const existing = app.businesses.findById(id)
          if (!existing) {
            counts.missing += 1
            rows.push({ id, outcome: 'missing' })
            continue
          }
          const target = REVIEW_ACTIONS[action]
          if (existing.verificationState === target) {
            // Already decided this way. Saying so is more useful than reporting
            // a change that did not happen.
            counts.unchanged += 1
            rows.push({ id, name: existing.name, outcome: 'unchanged' })
            continue
          }
          try {
            const updated = app.businesses.review(id, {
              action,
              reason,
              actor: { id: request.user.id, role: request.user.role },
            })
            app.audit.record({
              actorId: request.user.id,
              actorRole: request.user.role,
              action: `business.${action}`,
              entityType: 'business',
              entityId: updated.id,
              reason,
              before: existing,
              after: updated,
            })
            counts.updated += 1
            rows.push({ id, name: updated.name, outcome: 'updated' })
          } catch (error) {
            // One impossible transition does not abandon the other ninety-nine,
            // and it does not roll them back either: each is its own transaction
            // boundary inside the batch, and the outcome is reported per id.
            counts.refused += 1
            rows.push({
              id,
              name: existing.name,
              outcome: 'refused',
              from: existing.verificationState,
              reason: error.message,
            })
          }
        }

        return { counts, rows }
      })

      return single(decide(), { action, reason })
    },
  )

  fastify.post(
    '/admin/businesses/:id/status',
    {
      schema: {
        summary: 'Move a business through its lifecycle states.',
        tags: ['admin'],
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: [...BUSINESS_STATUSES] },
            reason: { type: 'string', maxLength: 500 },
          },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const before = app.businesses.requireById(request.params.id)
      const updated = app.businesses.setStatus(request.params.id, request.body.status)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'business.status',
        entityType: 'business',
        entityId: updated.id,
        before,
        after: updated,
      })
      return single(updated)
    },
  )

  /* Services ---------------------------------------------------------------- */

  fastify.post(
    '/admin/businesses/:id/services',
    {
      schema: {
        summary: 'Add a service to a business.',
        tags: ['admin'],
        params: idParamSchema,
        body: serviceBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request, reply) => {
      const service = app.businesses.addService(request.params.id, request.body)
      return reply.status(201).send(single(service))
    },
  )

  fastify.patch(
    '/admin/businesses/:id/services/:serviceId',
    {
      schema: {
        summary: 'Update one of a business\'s services.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'serviceId'],
          properties: { id: idParamSchema.properties.id, serviceId: idParamSchema.properties.id },
        },
        body: { type: 'object', minProperties: 1, properties: serviceBodySchema.properties },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single(app.businesses.updateService(request.params.serviceId, request.body)),
  )

  fastify.delete(
    '/admin/businesses/:id/services/:serviceId',
    {
      schema: {
        summary: 'Remove a service.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'serviceId'],
          properties: { id: idParamSchema.properties.id, serviceId: idParamSchema.properties.id },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single({ removed: app.businesses.removeService(request.params.serviceId) }),
  )

  /* Products ---------------------------------------------------------------- */

  fastify.post(
    '/admin/businesses/:id/products',
    {
      schema: {
        summary: 'Add a product to a business.',
        tags: ['admin'],
        params: idParamSchema,
        body: productBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request, reply) =>
      reply.status(201).send(single(app.businesses.addProduct(request.params.id, request.body))),
  )

  fastify.patch(
    '/admin/businesses/:id/products/:productId',
    {
      schema: {
        summary: 'Update one of a business\'s products.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'productId'],
          properties: { id: idParamSchema.properties.id, productId: idParamSchema.properties.id },
        },
        body: { type: 'object', minProperties: 1, properties: productBodySchema.properties },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single(app.businesses.updateProduct(request.params.productId, request.body)),
  )

  fastify.delete(
    '/admin/businesses/:id/products/:productId',
    {
      schema: {
        summary: 'Remove a product.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'productId'],
          properties: { id: idParamSchema.properties.id, productId: idParamSchema.properties.id },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single({ removed: app.businesses.removeProduct(request.params.productId) }),
  )

  /* Contact points ---------------------------------------------------------- */

  fastify.post(
    '/admin/businesses/:id/contacts',
    {
      schema: {
        summary: 'Add a contact point.',
        description: 'New contact points are unpublished unless the caller says otherwise.',
        tags: ['admin'],
        params: idParamSchema,
        body: contactBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(single(app.businesses.addContact(request.params.id, request.body))),
  )

  fastify.patch(
    '/admin/businesses/:id/contacts/:contactId',
    {
      schema: {
        summary: 'Publish, unpublish or mark a contact point primary.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'contactId'],
          properties: { id: idParamSchema.properties.id, contactId: idParamSchema.properties.id },
        },
        body: {
          type: 'object',
          minProperties: 1,
          properties: { isPublic: { type: 'boolean' }, isPrimary: { type: 'boolean' } },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single(
        app.businesses.setContactVisibility(request.params.contactId, request.body),
      ),
  )

  fastify.delete(
    '/admin/businesses/:id/contacts/:contactId',
    {
      schema: {
        summary: 'Remove a contact point.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'contactId'],
          properties: { id: idParamSchema.properties.id, contactId: idParamSchema.properties.id },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single({ removed: app.businesses.removeContact(request.params.contactId) }),
  )

  /* Skills ------------------------------------------------------------------ */

  fastify.post(
    '/admin/businesses/:id/skills',
    {
      schema: {
        summary: 'Attach a skill, creating the vocabulary entry if it is new.',
        tags: ['admin'],
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 80 },
            proficiency: { type: 'number', minimum: 0, maximum: 1 },
            isPrimary: { type: 'boolean' },
          },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    // 201 like every other create here: attaching a skill makes a new row, and a
    // client that branches on the status code should not have to learn that this
    // one route is the exception.
    async (request, reply) =>
      reply.status(201).send(
        single(
          app.businesses.addSkill(request.params.id, request.body.name, {
            proficiency: request.body.proficiency ?? 0.5,
            isPrimary: request.body.isPrimary ?? false,
          }),
        ),
      ),
  )

  fastify.delete(
    '/admin/businesses/:id/skills/:skillId',
    {
      schema: {
        summary: 'Detach a skill from a business.',
        tags: ['admin'],
        params: {
          type: 'object',
          required: ['id', 'skillId'],
          properties: { id: idParamSchema.properties.id, skillId: idParamSchema.properties.id },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) =>
      single({ removed: app.businesses.removeSkill(request.params.id, request.params.skillId) }),
  )
}
