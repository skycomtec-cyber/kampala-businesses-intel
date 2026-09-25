import { paged, single, toBoolean, toPage, toText, idParamSchema, uuidPattern } from '../lib/http.js'
import { COVERAGE_LEVELS, LOCATION_KINDS } from '../../core/location.js'
import { ValidationError } from '../../core/errors.js'

/**
 * Reference data: the vocabulary every other resource is expressed in.
 *
 * Locations, categories and skills are shared by the website, the mobile apps and
 * the analytics engine, so they get their own small, cacheable, rate-limited
 * surface rather than being folded into a search response. A client loads them
 * once at start-up and can then build every filter without a round trip.
 */

const locationQuerySchema = {
  type: 'object',
  properties: {
    // The list comes from core/location.js rather than being written out here.
    // A hand-copied enum had already drifted: it offered a `sub_county` that no
    // level uses and rejected the `division` rows the reference set actually
    // contains, so a client filtering on real data got a 400.
    kind: { type: 'string', enum: [...LOCATION_KINDS] },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
}

const slugQuerySchema = {
  type: 'object',
  properties: { q: { type: 'string', minLength: 1, maxLength: 80 } },
}

export default async function referenceRoutes(fastify, { app }) {
  /**
   * The category tree.
   *
   * `includeCounts` adds a live business count per category, which the browse UI
   * shows next to each node. It is opt-in because it is a per-node count over the
   * whole business table, and a menu that renders on every page load should not
   * pay for it unless it uses it.
   */
  fastify.get(
    '/categories',
    {
      schema: {
        summary: 'The full category tree, optionally with live business counts.',
        tags: ['reference'],
        querystring: {
          type: 'object',
          properties: { includeCounts: { type: 'boolean' } },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) =>
      single(
        app.categories.tree({
          includeCounts: toBoolean(request.query.includeCounts, 'includeCounts') ?? false,
        }),
      ),
  )

  fastify.get(
    '/categories/:id',
    {
      schema: {
        summary: 'One category, with its direct children and linked skills.',
        tags: ['reference'],
        params: idParamSchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) =>
      single({
        ...app.categories.requireById(request.params.id),
        children: app.categories.children(request.params.id),
        skills: app.categories.skillsFor(request.params.id),
      }),
  )

  fastify.get(
    '/locations',
    {
      schema: {
        summary: 'Administrative locations, filterable by level.',
        tags: ['reference'],
        querystring: locationQuerySchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const kind = toText(request.query.kind, { maxLength: 32 })
      const page = toPage(request.query, { defaultLimit: 500, maxLimit: 500 })
      // Unfiltered means every level, not just the country. A client asking for
      // "the locations" is asking for the set, and answering it with the single
      // root row would make the total disagree with the counts on /meta.
      return paged(kind ? app.locations.listByKind(kind, page) : app.locations.list(page), page)
    },
  )

  /**
   * A location with its ancestry, its subtree and the coverage levels the gap
   * engine can roll a search up to from here.
   *
   * All three in one response because a client that has just been handed a ward
   * id needs its breadcrumb, its children and its rollup options together, and
   * making it ask three times is how clients end up showing a partial tree.
   */
  fastify.get(
    '/locations/:id',
    {
      schema: {
        summary: 'A location with its ancestors, descendants and coverage levels.',
        tags: ['reference'],
        params: idParamSchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const { id } = request.params
      const location = app.locations.requireById(id)
      return single({
        ...location,
        ancestors: app.locations.ancestors(id),
        descendants: app.locations.descendants(id),
        coverageLevels: Object.fromEntries(
          COVERAGE_LEVELS.map((level) => [
            level,
            app.locations.coverageLocation(id, level),
          ]),
        ),
      })
    },
  )

  fastify.get(
    '/locations/:id/descendants',
    {
      schema: {
        summary: 'Everything inside a location, at any depth.',
        tags: ['reference'],
        params: idParamSchema,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 1000 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const page = toPage(request.query, { defaultLimit: 500, maxLimit: 1000 })
      const all = app.locations.descendants(request.params.id)
      return paged(all.slice(page.offset, page.offset + page.limit), {
        ...page,
        total: all.length,
      })
    },
  )

  /**
   * Skills, for the "what do you need?" step of a request form and for the search
   * filter. Prefix search over name and synonyms, which is what makes a
   * non-technical user who types "fridge" reach "refrigerator repair".
   */
  fastify.get(
    '/skills',
    {
      schema: {
        summary: 'The skill vocabulary, searchable by name or synonym.',
        tags: ['reference'],
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const term = toText(request.query.q, { maxLength: 80 })
      if (!term) throw new ValidationError('q is required.', { field: 'q' })
      const page = toPage(request.query, { defaultLimit: 25, maxLimit: 100 })
      return paged(app.skills.query({ term, ...page }), page)
    },
  )

  fastify.get(
    '/skills/:id',
    {
      schema: {
        summary: 'One skill and the categories it belongs to.',
        tags: ['reference'],
        params: idParamSchema,
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => single(app.skills.requireById(request.params.id)),
  )

  /**
   * A single place that answers "how many businesses are in this category, and
   * how many are in this ward". Used by the browse pages' counters, and by the
   * gap engine's UI when it explains an area as thin rather than absent.
   *
   * `includeSubtree` is the difference between "in Kampala" meaning the city node
   * and meaning everything inside it, which is almost always the second.
   */
  fastify.get(
    '/counts',
    {
      schema: {
        summary: 'Supply counts for a category and/or a location subtree.',
        tags: ['reference'],
        querystring: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', pattern: uuidPattern },
            locationId: { type: 'string', pattern: uuidPattern },
            includeSubtree: { type: 'boolean' },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const { categoryId = null, locationId = null } = request.query
      if (!categoryId && !locationId) {
        throw new ValidationError('Provide categoryId, locationId, or both.', {
          field: 'categoryId',
        })
      }
      return single({
        categoryId,
        locationId,
        includeSubtree: toBoolean(request.query.includeSubtree, 'includeSubtree') ?? false,
        total: app.businesses.count({
          categoryId,
          locationId,
          includeSubtree: toBoolean(request.query.includeSubtree, 'includeSubtree') ?? false,
        }),
      })
    },
  )
}
