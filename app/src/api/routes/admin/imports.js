import { single, toText } from '../../lib/http.js'
import { importBusinessesFromCsv, IMPORT_COLUMNS } from '../../../import/index.js'

/**
 * Admin: bulk import of a spreadsheet.
 *
 * The same importer the cli uses, over the wire, because a collection drive and
 * a field survey both end up as a file and both need the same guarantees. In
 * particular `dryRun` defaults to true here: an http call that creates hundreds
 * of listings from a payload nobody has read yet is the kind of endpoint that
 * gets called twice by a retrying client, and the whole point of the importer is
 * that being called twice is survivable rather than harmless.
 */

const importBodySchema = {
  type: 'object',
  required: ['csv'],
  properties: {
    csv: { type: 'string', minLength: 1, maxLength: 5000000 },
    dryRun: { type: 'boolean' },
    sourceId: { type: 'string', maxLength: 120 },
  },
}

export default async function adminImportRoutes(fastify, { app }) {
  fastify.get(
    '/admin/imports/businesses/schema',
    { preHandler: fastify.requireCapability('import:read') },
    async () =>
      single({
        required: IMPORT_COLUMNS.required,
        optional: IMPORT_COLUMNS.optional,
        notes: [
          'Category accepts a full path slug, a unique name, or an id: ' +
            'services/beauty-and-personal-care/barbering.',
          'Location accepts a full path, a trailing part of one (Kampala/Nakawa Division), ' +
            'a name that is unique in the reference data, or an id.',
          'Services and skills are separated by commas, semicolons or pipes, and are split ' +
            'inside quotes so a comma inside a name is not a separator.',
          'Phone numbers are normalised, so 0772 111 222 and +256772111222 match.',
          'A row is skipped when it matches an existing listing on a contact point, or, if it ' +
            'has no contact details, on the same name in the same location.',
        ],
      }),
  )

  fastify.post(
    '/admin/imports/businesses',
    {
      preHandler: fastify.requireCapability('import:write'),
      schema: { body: importBodySchema },
    },
    async (request) => {
      const { csv, dryRun = true } = request.body
      const sourceId = toText(request.body.sourceId, { maxLength: 120 }) ?? 'import:csv'

      const { summary, rows } = importBusinessesFromCsv(app, csv, { dryRun, sourceId })

      return single({ summary, rows }, { dryRun, sourceId })
    },
  )
}
