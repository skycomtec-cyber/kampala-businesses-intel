import { paged, single, toPage, toText, uuidPattern, idParamSchema } from '../../lib/http.js'
import { REVIEW_STATES, SOURCE_TYPES, TRUST_LEVELS } from '../../../core/catalogue.js'

/**
 * Admin: the catalogue itself.
 *
 * The rest of the admin api is about listings. This is about the question that
 * comes before them: where did this come from, and who says so?
 *
 * Three rules shape every route here.
 *
 *   1. A source is registered once and retired, never deleted. The records that
 *      arrived through it still exist and still need to point somewhere, so
 *      retiring flips it out of the intake picker and leaves its history readable.
 *
 *   2. Trust level is the field that matters. A source can be a national registry,
 *      a trade association, a directory somebody maintains, a community report, or
 *      a rumour, and the platform behaves differently for each. Changing it is a
 *      decision about the whole source, so it is audited with before and after.
 *
 *   3. Reading the queue never changes it. No `claim` on GET. An operator who
 *      merely looked at a queue must not be recorded as having taken the work,
 *      because the claim is what tells the next editor whose it is.
 */

const sourceBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    key: {
      type: 'string',
      minLength: 2,
      maxLength: 80,
      description: 'Stable identifier. Derived from the name when omitted.',
    },
    type: { type: 'string', enum: [...SOURCE_TYPES] },
    trustLevel: { type: 'string', enum: [...TRUST_LEVELS] },
    owner: { type: 'string', maxLength: 160 },
    uri: { type: 'string', maxLength: 300 },
    licence: { type: 'string', maxLength: 200 },
    notes: { type: 'string', maxLength: 2000 },
  },
}

export default async function adminCatalogueRoutes(fastify, { app }) {
  /**
   * The source register.
   *
   * Every source with its record count and its outstanding backlog, because a
   * register without those two numbers is a list of names, and the only question
   * anybody has of a source is "how much of this have we not looked at yet".
   */
  fastify.get(
    '/admin/catalogue/sources',
    {
      schema: {
        summary: 'Every catalogue source with its record and backlog counts.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...SOURCE_TYPES] },
            trustLevel: { type: 'string', enum: [...TRUST_LEVELS] },
            isActive: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('source:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      return paged(
        app.catalogue.listSources({
          type: request.query.type ?? null,
          trustLevel: request.query.trustLevel ?? null,
          isActive: request.query.isActive ?? null,
          ...page,
        }),
        page,
      )
    },
  )

  /**
   * What is waiting, and how much of it.
   *
   * The counts include the zeroes, so `verified: 0` is visible rather than
   * absent. A queue of a thousand waiting and nothing verified reads as a healthy
   * pipeline until somebody notices the public count has not moved.
   */
  fastify.get(
    '/admin/catalogue/queue',
    {
      schema: {
        summary: 'The review queue, with a count for every step including the empty ones.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: [...REVIEW_STATES] },
            sourceId: { type: 'string', pattern: uuidPattern },
            ownerId: { type: 'string', pattern: uuidPattern },
            unclaimed: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.catalogue.queue({
        state: request.query.state ?? null,
        sourceId: request.query.sourceId ?? null,
        ownerId: request.query.ownerId ?? null,
        unclaimed: request.query.unclaimed ?? false,
        ...page,
      })
      return paged(result, { ...page, counts: app.catalogue.queueCounts() })
    },
  )

  fastify.get(
    '/admin/catalogue/sources/:id',
    {
      schema: {
        summary: 'One source, with the records it supplied and its recent events.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('source:read'),
    },
    async (request) => {
      const source = app.catalogue.requireSourceById(request.params.id)
      const page = toPage(request.query)
      return single({
        ...source,
        records: app.catalogue.provenanceForSource(source.id, page),
      })
    },
  )

  fastify.post(
    '/admin/catalogue/sources',
    {
      schema: {
        summary: 'Register a source.',
        description:
          'Registering the same name twice returns the source that already exists ' +
          'rather than creating a second one, because the seed runs on every start.',
        tags: ['admin'],
        body: sourceBodySchema,
      },
      preHandler: fastify.requireCapability('source:write'),
    },
    async (request, reply) => {
      const created = app.catalogue.createSource(request.body)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'catalogue.source.create',
        entityType: 'catalogue_source',
        entityId: created.id,
        after: created,
      })
      return reply.status(201).send(single(created))
    },
  )

  fastify.patch(
    '/admin/catalogue/sources/:id',
    {
      schema: {
        summary: 'Update a source, including how far it is trusted.',
        tags: ['admin'],
        params: idParamSchema,
        body: { type: 'object', minProperties: 1, properties: sourceBodySchema.properties },
      },
      preHandler: fastify.requireCapability('source:write'),
    },
    async (request) => {
      const before = app.catalogue.requireSourceById(request.params.id)
      const updated = app.catalogue.updateSource(request.params.id, request.body)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'catalogue.source.update',
        entityType: 'catalogue_source',
        entityId: updated.id,
        reason: toText(request.body.reason, { maxLength: 500 }),
        before,
        after: updated,
      })
      return single(updated)
    },
  )

  /**
   * Retire, not delete.
   *
   * The records a source supplied are still in the directory and still need to be
   * able to say where they came from. A hard delete would leave them pointing at
   * nothing, and "we deleted the evidence" is the opposite of what an audit trail
   * is for.
   */
  fastify.delete(
    '/admin/catalogue/sources/:id',
    {
      schema: {
        summary: 'Retire a source. It can no longer supply records, and its history stays readable.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('source:write'),
    },
    async (request) => {
      const retired = app.catalogue.retireSource(request.params.id)
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'catalogue.source.retire',
        entityType: 'catalogue_source',
        entityId: retired.id,
        after: retired,
      })
      return single(retired)
    },
  )

  /**
   * One record's whole story: where it came from, and every decision made about it.
   *
   * Provenance and events together, because the question a reviewer actually has
   * is "this says it came from a national registry, and somebody approved it on
   * Tuesday" and answering it takes both halves.
   */
  fastify.get(
    '/admin/catalogue/businesses/:id',
    {
      schema: {
        summary: 'A record\'s provenance and full review history.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('source:read'),
    },
    async (request) => single(app.catalogue.trail(request.params.id)),
  )

  /**
   * Records that arrived with nothing saying where they came from.
   *
   * The hole in the system, listed rather than hidden. Every pre-pipeline listing
   * is in here on the day the migration runs, and the count going down is the only
   * honest measure of whether anyone is actually using intake.
   */
  fastify.get(
    '/admin/catalogue/orphans',
    {
      schema: {
        summary: 'Records with no provenance row.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('source:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      return paged(
        {
          total: app.catalogue.countRecordsWithoutProvenance(),
          items: app.catalogue.recordsWithoutProvenance(page),
        },
        page,
      )
    },
  )

  /**
   * Harvest runs: one row per ingestion of a source's file.
   *
   * The list answers "what have we fed this directory, and did it work". The
   * single-run view adds the reconciliation: the references this source has
   * described before that this run did not mention. That report is the point of
   * the whole phase — it is how an operator notices that a file used to carry four
   * hundred businesses and now carries three hundred and ninety — and it changes
   * nothing by design, because a record missing from a file is evidence the file
   * changed, not evidence the business closed.
   */
  fastify.get(
    '/admin/catalogue/imports',
    {
      schema: {
        summary: 'Ingestion runs, most recent first.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            sourceId: { type: 'string', pattern: uuidPattern },
            status: { type: 'string', enum: ['running', 'completed', 'failed'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('import:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      return paged(
        app.catalogue.listRuns({
          sourceId: request.query.sourceId ?? null,
          status: request.query.status ?? null,
          ...page,
        }),
        page,
      )
    },
  )

  fastify.get(
    '/admin/catalogue/imports/:id',
    {
      schema: {
        summary: 'One run, with the references this source described before that it did not repeat.',
        tags: ['admin'],
        params: idParamSchema,
      },
      preHandler: fastify.requireCapability('import:read'),
    },
    async (request) => single(app.catalogue.reconcileRun(request.params.id)),
  )
}
