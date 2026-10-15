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
    sourceKey: {
      type: 'string',
      maxLength: 80,
      description:
        'A registered catalogue source. When set, the import is recorded as a run ' +
        'and every created listing gets provenance back to this source.',
    },
    batchRef: { type: 'string', maxLength: 120 },
    filename: { type: 'string', maxLength: 300 },
    evidence: { type: 'string', maxLength: 500 },
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
          'Services and skills are separated by commas, semicolons or pipes. A name that ' +
            'itself contains a comma must be written with a semicolon or a pipe instead, ' +
            'because splitting happens after the cell is read.',
          'Phone numbers are normalised, so 0772 111 222 and +256772111222 match.',
          'A row is skipped when it matches an existing listing on a contact point, or, if it ' +
            'has no contact details, on the same name in the same location.',
          'A row is rejected when its category or location is not in the reference data, or ' +
            'when the category is a branch rather than a leaf. Those are collected into ' +
            '"unresolved" in the response, with the parent each one belongs under, and can ' +
            'be posted to /admin/reference/locations/bulk or /admin/reference/categories/bulk.',
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
      const { csv, dryRun = true, batchRef = null, filename = null, evidence = null } =
        request.body
      const sourceId = toText(request.body.sourceId, { maxLength: 120 }) ?? 'import:csv'
      const sourceKey = toText(request.body.sourceKey, { maxLength: 80 })

      const { summary, rows, unresolved, source, run, reconciliation } = importBusinessesFromCsv(
        app,
        csv,
        {
          dryRun,
          sourceId,
          sourceKey,
          batchRef,
          filename,
          evidence,
          // The run records who fed it, so a source's history names a person and
          // not only a file. A dry run writes no run, so this is simply ignored.
          actor: { id: request.user.id, role: request.user.role },
        },
      )

      return single(
        { summary, rows, unresolved, run, reconciliation },
        { dryRun, sourceId, sourceKey: source?.key ?? null },
      )
    },
  )
}
