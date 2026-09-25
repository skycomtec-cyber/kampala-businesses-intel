import { single, toText } from '../../lib/http.js'
import { DomainError, ValidationError } from '../../../core/errors.js'
import { LOCATION_KINDS } from '../../../core/location.js'
import { slugify } from '../../../core/identifiers.js'

/**
 * Admin: extending the reference trees.
 *
 * The importer refuses to invent a category or a division, which is right, but it
 * left the operator with no way to act on that refusal: the rejection message
 * pointed at an admin api for adding reference entries that did not exist. These
 * routes are that api.
 *
 * The bulk form takes the `unresolved` block of an import report verbatim, which
 * is the whole point. The report already knows the parent each missing place
 * belongs under, because resolution walked the path before it gave up, so the
 * operator is confirming names and supplying the one thing software cannot know:
 * what kind of place it is. Nothing here is guessable, so nothing here is
 * defaulted.
 */

const MAX_BULK = 200

const locationBodySchema = {
  type: 'object',
  required: ['name', 'kind'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 160 },
    kind: { type: 'string', enum: LOCATION_KINDS },
    parentId: { type: 'string' },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
  },
}

const locationBulkSchema = {
  type: 'object',
  required: ['locations'],
  properties: {
    locations: { type: 'array', minItems: 1, maxItems: MAX_BULK, items: locationBodySchema },
    sourceId: { type: 'string', maxLength: 120 },
  },
}

const categoryBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    parentId: { type: 'string' },
    description: { type: 'string', maxLength: 1000 },
    icon: { type: 'string', maxLength: 120 },
    vertical: { type: 'string', maxLength: 80 },
  },
}

const categoryBulkSchema = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: { type: 'array', minItems: 1, maxItems: MAX_BULK, items: categoryBodySchema },
    sourceId: { type: 'string', maxLength: 120 },
  },
}

export default async function adminReferenceRoutes(fastify, { app }) {
  const write = fastify.requireCapability('reference:write')

  fastify.post(
    '/admin/reference/locations',
    { preHandler: write, schema: { body: locationBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(single({ location: createLocation(app, request.body) })),
  )

  fastify.post(
    '/admin/reference/locations/bulk',
    { preHandler: write, schema: { body: locationBulkSchema } },
    async (request, reply) => {
      const { locations, sourceId } = request.body
      const result = applyAll(locations, (entry) => ({
        outcome: 'created',
        location: createLocation(app, { ...entry, sourceId }),
      }), app.locations, (entry) => ({
        kind: entry.kind,
        name: entry.name,
        parentId: entry.parentId ?? null,
      }))
      return reply.code(201).send(single(result))
    },
  )

  fastify.post(
    '/admin/reference/categories',
    { preHandler: write, schema: { body: categoryBodySchema } },
    async (request, reply) =>
      reply
        .code(201)
        .send(single({ category: createCategory(app, request.body) })),
  )

  fastify.post(
    '/admin/reference/categories/bulk',
    { preHandler: write, schema: { body: categoryBulkSchema } },
    async (request, reply) => {
      const { categories, sourceId } = request.body
      const result = applyAll(categories, (entry) => ({
        outcome: 'created',
        category: createCategory(app, { ...entry, sourceId }),
      }), app.categories, (entry) => ({
        name: entry.name,
        parentId: entry.parentId ?? null,
      }))
      return reply.code(201).send(single(result))
    },
  )
}

function createLocation(app, body) {
  const name = toText(body.name, { maxLength: 160 })
  const kind = toText(body.kind, { maxLength: 40 })
  if (!kind || !LOCATION_KINDS.includes(kind)) {
    throw new ValidationError(
      `"${kind}" is not a kind of place. Use one of: ${LOCATION_KINDS.join(', ')}.`,
      { field: 'kind', allowed: LOCATION_KINDS },
    )
  }
  return app.locations.create({
    name,
    kind,
    parentId: toText(body.parentId) ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    sourceId: toText(body.sourceId) ?? null,
  })
}

function createCategory(app, body) {
  return app.categories.create({
    name: toText(body.name, { maxLength: 120 }),
    parentId: toText(body.parentId) ?? null,
    description: toText(body.description, { maxLength: 1000 }) ?? null,
    icon: toText(body.icon, { maxLength: 120 }) ?? null,
    vertical: toText(body.vertical, { maxLength: 80 }) ?? null,
    sourceId: toText(body.sourceId) ?? null,
  })
}

/**
 * Applies a batch one entry at a time, reporting each outcome separately.
 *
 * Not all-or-nothing on purpose. The input is a rejection report, so a duplicate
 * means the operator sent the same report twice, which is the one failure this
 * feature has to survive; failing the whole batch on a duplicate would make
 * retrying a partially applied batch impossible. A genuinely broken entry, such
 * as a ward placed under a district that forbids wards, is still reported as
 * failed and does not stop the rest.
 *
 * The duplicate test is the repository's own slug rule rather than a name
 * comparison, so "Nakawa Central" and "nakawa central" are recognised as the one
 * place they are, the same way the create call would have refused them.
 */
function applyAll(entries, onCreate, repository, identityOf) {
  const result = { created: [], skipped: [], failed: [] }
  for (const entry of entries) {
    try {
      const identity = identityOf(entry)
      const existing = repository.findBySlug(slugify(identity.name), identity.parentId)
      if (existing) {
        result.skipped.push({ ...entry, existingId: existing.id })
        continue
      }
      result.created.push({ ...entry, ...onCreate(entry) })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      result.failed.push({ ...entry, reason: error.message })
    }
  }
  return { counts: countsOf(result), ...result }
}

function countsOf(result) {
  return {
    created: result.created.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  }
}
