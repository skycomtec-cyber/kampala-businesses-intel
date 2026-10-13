import { collection, paged, single, toPage, toText, uuidPattern } from '../lib/http.js'
import { NotFoundError } from '../../core/errors.js'
import {
  SECOND_LIFE_ACTIVITIES,
  ACTIVITY_LABELS,
  DEVICE_TYPES,
  RECEIVED_CONDITIONS,
  INTAKE_STAGES,
  INTAKE_OUTCOMES,
  INTAKE_CLOSED_STAGE,
  SECOND_LIFE_ROOT_SLUG,
  categorySlugForActivity,
} from '../../core/secondLife.js'

/**
 * Second Life Electronics.
 *
 * The vertical is already browsable — its six subcategories are in the taxonomy
 * and every listing under them is served by the business routes. What is added
 * here is the part a directory cannot express: the operational record of the
 * devices themselves, walked from intake to a named outcome.
 *
 * Only one route is public. `GET /second-life/activities` is the vertical's own
 * table of contents, and it exists so a client can map an activity onto the
 * category that holds its listings without hardcoding the mapping. Everything
 * else is an operator read or write, because an intake names a specific device
 * and who it belongs to and there is no version of that which belongs on the open
 * web.
 *
 * A write names the business it is for in the path rather than the body, matching
 * the marketplace's offer routes, so the capability check and the record it
 * applies to are impossible to separate by accident.
 */

const referenceParamsSchema = {
  type: 'object',
  required: ['reference'],
  properties: { reference: { type: 'string', pattern: '^SL-[0-9]{4}-[0-9]{5}$' } },
}

const businessParamsSchema = {
  type: 'object',
  required: ['businessId'],
  properties: { businessId: { type: 'string', pattern: uuidPattern } },
}

const intakeBodySchema = {
  type: 'object',
  required: ['activity', 'deviceType', 'receivedCondition'],
  additionalProperties: false,
  properties: {
    activity: { type: 'string', enum: [...SECOND_LIFE_ACTIVITIES] },
    deviceType: { type: 'string', enum: [...DEVICE_TYPES] },
    receivedCondition: { type: 'string', enum: [...RECEIVED_CONDITIONS] },
    // Optional. When omitted the repository files the intake under the activity's
    // own subcategory; a caller that knows better may name a different one.
    categoryId: { type: 'string', pattern: uuidPattern },
    make: { type: 'string', maxLength: 80 },
    model: { type: 'string', maxLength: 120 },
    quantity: { type: 'integer', minimum: 1, maximum: 999 },
    ownerRef: { type: 'string', maxLength: 120 },
    notes: { type: 'string', maxLength: 2000 },
    dataWipeRequested: { type: 'boolean' },
  },
}

const advanceBodySchema = {
  type: 'object',
  required: ['stage'],
  additionalProperties: false,
  properties: {
    stage: { type: 'string', enum: [...INTAKE_STAGES] },
    note: { type: 'string', maxLength: 500 },
  },
}

const closeBodySchema = {
  type: 'object',
  required: ['outcome'],
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: [...INTAKE_OUTCOMES] },
    note: { type: 'string', maxLength: 500 },
    dataWipeCompleted: { type: 'boolean' },
  },
}

export default async function secondLifeRoutes(fastify, { app }) {
  /**
   * The vertical's table of contents.
   *
   * Each activity with the subcategory it is filed under, resolved to a live
   * category id. Resolved rather than hardcoded because category ids are per
   * database, and a client that hardcoded them would break the first time the
   * reference dataset was reseeded.
   */
  fastify.get(
    '/second-life/activities',
    {
      schema: {
        summary: "Second Life Electronics' six activities and the category each is filed under.",
        tags: ['second-life'],
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async () => {
      const root = app.categories.findBySlug(SECOND_LIFE_ROOT_SLUG)
      const data = SECOND_LIFE_ACTIVITIES.map((activity) => {
        const slug = categorySlugForActivity(activity)
        const category = root ? app.categories.findBySlug(slug, root.id) : null
        return {
          activity,
          label: ACTIVITY_LABELS[activity],
          categorySlug: slug,
          categoryId: category?.id ?? null,
        }
      })
      return collection(data, {
        total: data.length,
        limit: data.length,
        offset: 0,
        rootSlug: SECOND_LIFE_ROOT_SLUG,
      })
    },
  )

  /**
   * Take a device in.
   *
   * The record is created for a named business with `business:write`. The business
   * only has to exist — unlike an offer it is not required to be publicly visible,
   * because an intake is the business's own working record and a workshop
   * tracking its own jobs before it has been published is exactly the case this is
   * for.
   */
  fastify.post(
    '/second-life/businesses/:businessId/intakes',
    {
      schema: {
        summary: 'Take a device in, opening an intake for it.',
        description:
          'Requires an operator session with `business:write`. The reference returned is quoted over the counter.',
        tags: ['second-life'],
        params: businessParamsSchema,
        body: intakeBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request, reply) => {
      const business = app.businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)

      const created = app.secondLife.create({
        ...request.body,
        businessId: business.id,
        // Fill in the subcategory from the activity when the caller did not.
        categoryId:
          request.body.categoryId ??
          resolveCategoryId(app, request.body.activity),
        actorId: request.user.id,
      })

      reply.header(
        'location',
        `${fastify.kip.config.api.prefix}/second-life/intakes/${created.reference}`,
      )
      return reply.status(201).send(single(created))
    },
  )

  /**
   * A business's intake book.
   *
   * The filter an operator actually uses: what is still open, and what closed and
   * how. `stage` defaults to nothing rather than to "open", because a shop that
   * wants its history should get it without a second request.
   */
  fastify.get(
    '/second-life/businesses/:businessId/intakes',
    {
      schema: {
        summary: 'The device intakes held by a business.',
        tags: ['second-life'],
        params: businessParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stage: { type: 'string', enum: [...INTAKE_STAGES] },
            outcome: { type: 'string', enum: [...INTAKE_OUTCOMES] },
            activity: { type: 'string', enum: [...SECOND_LIFE_ACTIVITIES] },
            deviceType: { type: 'string', enum: [...DEVICE_TYPES] },
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
      const business = app.businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)
      const page = toPage(request.query)
      const result = app.secondLife.list({
        businessId: business.id,
        stage: request.query.stage ?? null,
        outcome: request.query.outcome ?? null,
        activity: request.query.activity ?? null,
        deviceType: request.query.deviceType ?? null,
        search: toText(request.query.search, { maxLength: 120 }),
        sort: request.query.sort ?? 'newest',
        ...page,
      })
      return paged(result, page)
    },
  )

  /**
   * A business's vertical numbers.
   *
   * The one read a shop owner has that the directory cannot give them: how much
   * comes in, how it ends, and whether the wipes they promised actually happened.
   * Scoped to the business in the path, never platform-wide, because it is their
   * book and not a market statistic.
   */
  fastify.get(
    '/second-life/businesses/:businessId/summary',
    {
      schema: {
        summary: "A business's intake counts by stage, outcome and activity.",
        tags: ['second-life'],
        params: businessParamsSchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const business = app.businesses.findById(request.params.businessId)
      if (!business) throw new NotFoundError('Business', request.params.businessId)
      return single(app.secondLife.summary({ businessId: business.id }))
    },
  )

  /**
   * One intake, with its history and its legal next moves.
   *
   * `nextStages` is computed on the server rather than left to the client so the
   * buttons a page offers and the moves the api will accept can never drift apart.
   */
  fastify.get(
    '/second-life/intakes/:reference',
    {
      schema: {
        summary: 'One device intake, its history and the stages it may move to next.',
        tags: ['second-life'],
        params: referenceParamsSchema,
      },
      preHandler: fastify.requireCapability('business:read'),
    },
    async (request) => {
      const intake = app.secondLife.requireByReference(request.params.reference)
      return single(app.secondLife.detail(intake.id))
    },
  )

  /**
   * Move an intake forward.
   *
   * Backward moves and skips to `closed` are refused by the domain rule, so this
   * route does not restate them: it calls `advance`, which owns the rule.
   */
  fastify.post(
    '/second-life/intakes/:reference/advance',
    {
      schema: {
        summary: 'Move an intake forward a stage.',
        tags: ['second-life'],
        params: referenceParamsSchema,
        body: advanceBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const intake = app.secondLife.requireByReference(request.params.reference)
      return single(
        app.secondLife.advance(intake.id, request.body.stage, {
          actorId: request.user.id,
          note: request.body.note ?? null,
        }),
      )
    },
  )

  /**
   * Close an intake with an outcome.
   *
   * The data-wipe rule is applied here: an intake with an outstanding, requested
   * wipe cannot be closed as resold, parts-recovered, recycled or returned, and
   * the error names the two ways out.
   */
  fastify.post(
    '/second-life/intakes/:reference/close',
    {
      schema: {
        summary: 'Close an intake, recording what happened to the device.',
        tags: ['second-life'],
        params: referenceParamsSchema,
        body: closeBodySchema,
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const intake = app.secondLife.requireByReference(request.params.reference)
      return single(
        app.secondLife.close(intake.id, request.body.outcome, {
          actorId: request.user.id,
          note: request.body.note ?? null,
          dataWipeCompleted: request.body.dataWipeCompleted ?? false,
        }),
      )
    },
  )

  /**
   * Record a requested wipe as done.
   *
   * Its own route because the wipe is often finished before the job is, and the
   * alternative — folding it into close — would make operators choose between
   * recording the wipe late and closing the job early.
   */
  fastify.post(
    '/second-life/intakes/:reference/wipe',
    {
      schema: {
        summary: 'Record that a requested data wipe was completed.',
        tags: ['second-life'],
        params: referenceParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { note: { type: 'string', maxLength: 500 } },
        },
      },
      preHandler: fastify.requireCapability('business:write'),
    },
    async (request) => {
      const intake = app.secondLife.requireByReference(request.params.reference)
      return single(
        app.secondLife.completeWipe(intake.id, {
          actorId: request.user.id,
          note: request.body?.note ?? null,
        }),
      )
    },
  )
}

/**
 * Resolves an activity to the id of its subcategory, or null.
 *
 * Null rather than an error when the reference data is absent: an intake with no
 * category is still a valid record, and the seed is a separate step. The same
 * choice the repository makes when no category is supplied at all.
 */
function resolveCategoryId(app, activity) {
  const root = app.categories.findBySlug(SECOND_LIFE_ROOT_SLUG)
  if (!root) return null
  const category = app.categories.findBySlug(categorySlugForActivity(activity), root.id)
  return category?.id ?? null
}
