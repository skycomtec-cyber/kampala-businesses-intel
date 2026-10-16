/**
 * The importer.
 *
 * Indexing Kampala is a spreadsheet problem before it is a code problem: somebody
 * walks a market with a phone, and comes back with a CSV. Everything here
 * exists to make that spreadsheet safe to replay.
 *
 * Three properties matter more than speed.
 *
 * Nothing invented. A row that does not resolve is a failed row, not a business
 * with a guessed name or a default location. A directory that fills in the
 * blanks is a directory that lies about where supply is, and the gap engine
 * would then publish confident conclusions about markets nobody has described.
 *
 * Replaying a file is safe. Importing the same sheet twice must not double the
 * directory, so a row is matched against existing listings on its contact points
 * and, failing that, on its name within its location, and reported as skipped
 * rather than written again.
 *
 * A bad row is contained. One unparseable phone number must not lose the other
 * four hundred businesses on the sheet, so rows are validated independently and
 * every rejection is reported with the line it came from.
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'

import { parseCsv, toRecords, splitList } from './csv.js'
import { buildImportRow, resolveCategory, resolveLocation, IMPORT_COLUMNS } from './rows.js'
import { ValidationError, DomainError, ConflictError } from '../core/errors.js'
import { canonicalContactValue } from '../core/business.js'
import { slugify } from '../core/identifiers.js'

/**
 * The outcome of one row.
 *
 * `skipped` is not a failure: it is the file being replayed, or a row whose
 * business is already in the directory under another name.
 */
const OUTCOMES = Object.freeze(['created', 'skipped', 'updated', 'failed'])

/**
 * Imports businesses from CSV text.
 *
 * `sourceId` is the legacy free-text origin column and is kept because listings
 * written before the catalogue existed carry it. `sourceKey` names a registered
 * catalogue source instead, and it changes what the import records: the run is
 * opened and closed around the file, and every listing the run creates — plus
 * every row it recognises as one this source has described before — gets a
 * provenance row tied back to that source and that run. Without a key the import
 * behaves exactly as it always has, which is what keeps every existing file and
 * caller working.
 *
 * @param {object} app the open database handle and repositories
 * @param {string} text the file contents
 * @param {object} [options]
 * @param {boolean} [options.dryRun] validate and report without writing
 * @param {string} [options.sourceId] legacy origin text recorded on created listings
 * @param {string} [options.sourceKey] registered source to attribute the import to
 * @param {string} [options.batchRef] a name for this batch, e.g. a month
 * @param {string} [options.filename] the file this text came from, for the run list
 * @param {string} [options.contentSha256] overrides the hash computed from the text
 * @param {object} [options.actor] the user performing the import, for provenance
 * @param {string} [options.evidence] what makes the file checkable, e.g. a url.
 *   A row's own `evidence` column wins over this, so a harvested batch can point
 *   each record at the page it was read from while a spreadsheet still gets one
 *   answer for the whole file.
 * @param {string} [options.notes] a note for the run record
 * @param {(progress: object) => void} [options.onRow] called per row, for a CLI
 * @returns {{ summary: object, rows: object[], source: object|null, run: object|null, reconciliation: object|null }}
 */
export function importBusinessesFromCsv(app, text, options = {}) {
  const {
    dryRun = false,
    sourceId = 'import:csv',
    sourceKey = null,
    batchRef = null,
    filename = null,
    contentSha256 = null,
    actor = null,
    evidence = null,
    notes = null,
    onRow = null,
  } = options

  // A key that names no source, or one that has been retired, is refused before a
  // single row is read. Attributing a file to a source the catalogue does not know
  // is precisely the uncountable state this phase exists to remove, and a retired
  // source is one somebody decided should stop supplying records.
  const source = sourceKey ? app.catalogue.requireSourceByKey(sourceKey) : null
  if (source && !source.isActive) {
    throw new ConflictError(
      `Catalogue source "${source.key}" is retired, so it cannot be fed new records.`,
      { source: source.key },
    )
  }

  requireReferenceData(app)

  const parsed = parseCsv(text)
  const { records, lineOf } = toRecords(parsed, { required: IMPORT_COLUMNS.required })

  const summary = {
    total: records.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    dryRun,
  }
  const rows = []

  // The run opens before the first row and closes after the last, and a dry run
  // never opens one: a run is a claim that ingestion happened, and a dry run is
  // the rehearsal that proves nothing did.
  const contentHash =
    source === null
      ? null
      : contentSha256 ?? createHash('sha256').update(text, 'utf8').digest('hex')
  const run =
    source && !dryRun
      ? app.catalogue.beginRun({
          sourceId: source.id,
          batchRef,
          filename,
          contentSha256: contentHash,
          actor,
          notes,
        })
      : null

  // Distinct places and categories the file referred to that the reference data
  // does not have, with every line that wanted them. A 400 row survey of an area
  // nobody has mapped yet fails on a handful of wards, not 400 different ones,
  // and the operator should be able to read that off the report and add them in
  // one call rather than discovering the same gap four hundred times.
  const unresolved = new Map()

  // Names and contacts already in the directory, so a file that is internally
  // consistent is deduplicated against itself as well as against what is stored.
  // Both are maps because a duplicate report has to name the listing it matched.
  const seenNames = new Map(
    app.businesses.all().map((row) => [nameKey(row.name, row.primaryLocationId), row]),
  )
  const seenContacts = new Map()

  try {
    for (const [index, record] of records.entries()) {
      const line = lineOf[index]
      const outcome = { line, name: record.name ?? '', outcome: null, detail: null, id: null }

      try {
        const { input, contacts, services, externalRef, evidence: rowEvidence } = buildImportRow(app, record)
        // A row may carry its own evidence — a harvest reads each record off a
        // different page — and it wins over the file-level evidence, which is the
        // one fallback a hand-written spreadsheet still gets.
        const effectiveEvidence = rowEvidence ?? evidence
        const effectiveSourceId = source ? source.key : sourceId
        if (effectiveSourceId && !record.source) input.sourceId = effectiveSourceId
        // Set here as well as by provenance, so the listing carries its source in
        // the same row even if the provenance write were ever skipped.
        if (source) input.catalogueSourceId = source.id

        const duplicate = findDuplicate(app, { input, contacts, seenContacts, seenNames })
        if (duplicate) {
          outcome.outcome = 'skipped'
          outcome.detail = duplicate.reason
          outcome.id = duplicate.business.id
          summary.skipped += 1
          // A skipped row the file identified by reference is still this source
          // describing that business, so the reference is recorded as a secondary
          // origin — attachToBusiness is false, so the record keeps whichever
          // source first claimed it. This is what lets a replayed file count as
          // having *seen* those references, which is the whole basis of the
          // staleness report: a re-run that skips everything is a run in which
          // nothing went stale.
          if (source && externalRef && run) {
            app.catalogue.recordProvenance(duplicate.business.id, {
              sourceId: source.id,
              externalRef,
              batchRef,
              evidence: effectiveEvidence,
              notes,
              runId: run.id,
              importedBy: actor?.id ?? null,
              attachToBusiness: false,
            })
          }
        } else if (dryRun) {
          // In a dry run the row is counted as it would be created, but nothing is
          // written, and the name is still reserved so that a file with two
          // identical rows reports one created and one skipped.
          outcome.outcome = 'created'
          outcome.detail = 'would create'
          summary.created += 1
          reserve(seenNames, seenContacts, input, contacts)
        } else {
          const created = writeBusiness(
            app,
            input,
            contacts,
            services,
            source
              ? {
                  sourceId: source.id,
                  externalRef,
                  batchRef,
                  evidence: effectiveEvidence,
                  notes,
                  runId: run?.id ?? null,
                  importedBy: actor?.id ?? null,
                }
              : null,
          )
          outcome.outcome = 'created'
          outcome.id = created.id
          outcome.detail = created.slug
          summary.created += 1
          reserve(seenNames, seenContacts, input, contacts)
        }
      } catch (error) {
        if (error instanceof DomainError || error instanceof ValidationError) {
          outcome.outcome = 'failed'
          outcome.detail = error.message
          summary.failed += 1
          if (error.details?.reference) {
            noteUnresolved(unresolved, error.details.reference, line)
          }
        } else {
          // An unexpected failure is still contained to its row, but it is not
          // disguised as a data problem: the operator needs to know it is a bug.
          outcome.outcome = 'failed'
          outcome.detail = `Unexpected: ${error.message}`
          summary.failed += 1
        }
      }

      rows.push(outcome)
      onRow?.(outcome)
    }
  } catch (error) {
    // Only an error the per-row handler cannot contain reaches here. The run is
    // closed as failed with what it managed before it stopped, because "the
    // import died after sixty rows" is a fact the next operator needs.
    if (run) closeRun(app, run.id, summary, 'failed', error.message)
    throw error
  }

  let reconciliation = null
  if (run) {
    closeRun(app, run.id, summary, 'completed')
    reconciliation = app.catalogue.reconcileRun(run.id)
  }

  return {
    summary,
    rows,
    unresolved: listUnresolved(unresolved),
    source: source ?? null,
    run: run ? app.catalogue.findRunById(run.id) : null,
    reconciliation,
  }
}

function closeRun(app, runId, summary, status, notes = null) {
  app.catalogue.finishRun(runId, {
    status,
    total: summary.total,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
    notes,
  })
}

/**
 * Groups one failed reference by what was asked for, not by line.
 *
 * Kept sorted and deduplicated so re-running a file produces a byte-identical
 * report, which is what makes the report diffable in a review.
 */
function noteUnresolved(unresolved, reference, line) {
  const key = `${reference.type}:${slugify(reference.value)}:${reference.parentId ?? ''}`
  const existing = unresolved.get(key)
  if (existing) {
    existing.lines.push(line)
    return
  }
  unresolved.set(key, { ...reference, lines: [line] })
}

function listUnresolved(unresolved) {
  return [...unresolved.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value),
  )
}

/**
 * Refuses to run without the reference dataset.
 *
 * Every row is resolved against the seeded taxonomy and geography, so an empty
 * database would fail every row with a message about a category that does not
 * exist. Saying what is actually wrong, and how to fix it, saves the operator
 * from reading four hundred identical errors.
 */
function requireReferenceData(app) {
  const categories = app.categories.all().length
  const locations = app.locations.list({ limit: 1 }).total
  if (categories === 0 || locations === 0) {
    throw new Error(
      'Reference data is missing ' +
        `(${categories} categories, ${locations} locations). ` +
        'The importer resolves every row against it and will not invent entries, ' +
        'so run "npm run seed" first.',
    )
  }
}

/**
 * Creates the listing and everything attached to it, as one unit of work.
 *
 * The repositories each open their own transaction, and better-sqlite3 turns a
 * transaction opened inside another one into a savepoint, so wrapping the whole
 * row here is what makes it atomic. Without it, a row whose phone number is
 * rejected half way through would leave behind a listing with no contact
 * details, which reads in the directory exactly like a real business that has
 * no phone number.
 *
 * Provenance is written inside the same transaction when the import is attributed
 * to a source, so the listing and the claim about where it came from either both
 * exist or neither does. A record with no provenance is the uncountable state the
 * catalogue is meant to make impossible.
 */
function writeBusiness(app, input, contacts, services, provenance = null) {
  const write = app.db.transaction(() => {
    const created = app.businesses.create(input)
    for (const contact of contacts) {
      app.businesses.addContact(created.id, contact)
    }
    for (const name of services) {
      app.businesses.addService(created.id, { name })
    }
    if (provenance) {
      app.catalogue.recordProvenance(created.id, provenance)
    }
    return created
  })
  return write()
}

/**
 * Decides whether a row is already in the directory.
 *
 * Contact points are checked first and in order of how strong an identity signal
 * they are: a phone number is the same business far more reliably than a name,
 * because "Bright Future Bakery" is a name three businesses on one road can
 * share. A name in the same location is the weakest signal and is only used when
 * the row carried no contact details at all, since a name match across the whole
 * country would match almost nothing usefully and would still match the wrong
 * thing often enough to matter.
 */
function findDuplicate(app, { input, contacts, seenContacts, seenNames }) {
  for (const contact of contacts) {
    for (const kind of candidateKinds(contact.kind)) {
      // The key is the canonical value, not the text from the spreadsheet, so
      // two rows in one file that type the same number differently are
      // recognised as one business. A dry run therefore reports the same
      // duplicates a real run would.
      const key = contactKey(kind, contact.value)
      if (key && seenContacts.has(key)) {
        return {
          business: seenContacts.get(key),
          reason: `${contact.kind} already seen in this file as "${seenContacts.get(key).name}"`,
        }
      }
      const existing = app.businesses.findByContact({ kind, value: contact.value })
      if (existing) {
        return { business: existing, reason: `${contact.kind} matches "${existing.name}"` }
      }
    }
  }

  const key = nameKey(input.name, input.locationId)
  if (contacts.length === 0) {
    // Checked only for a row with no contact details. Two unrelated shops can
    // share a name on one road, so a name match must never override a contact
    // point that says otherwise; it is only evidence when there is nothing else
    // to go on.
    if (seenNames.has(key)) {
      return {
        business: seenNames.get(key),
        reason: 'the same name already appears in this file, with no contact details to tell them apart',
      }
    }
    const existing = app.businesses.findByName(input.name, input.locationId)
    if (existing) {
      return {
        business: existing,
        reason: `an unnamed listing for "${existing.name}" already exists in that location`,
      }
    }
  }
  return null
}

/** WhatsApp and phone are the same identity, so a lookup tries both kinds. */
function candidateKinds(kind) {
  return kind === 'phone' || kind === 'whatsapp' ? ['phone', 'whatsapp'] : [kind]
}

function contactKey(kind, value) {
  const canonical = canonicalContactValue(kind, value)
  return canonical === null ? null : `${kind}:${canonical.toLowerCase()}`
}

function reserve(seenNames, seenContacts, input, contacts) {
  seenNames.set(nameKey(input.name, input.locationId), { name: input.name, id: null })
  for (const contact of contacts) {
    for (const kind of candidateKinds(contact.kind)) {
      const key = contactKey(kind, contact.value)
      if (key) seenContacts.set(key, { name: input.name, id: null })
    }
  }
}

/** A name is only an identity claim together with the place it was claimed in. */
function nameKey(name, locationId) {
  return `${slugify(name)}@${locationId}`
}

/**
 * Reads a CSV file from disk and imports it.
 *
 * Separated from the text-level import so a test, and the api route, can import
 * the same bytes without going through the filesystem.
 */
export function importBusinessesFromFile(app, filePath, options = {}) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`, { cause: error })
  }
  return importBusinessesFromCsv(app, text, options)
}

export { IMPORT_COLUMNS, resolveCategory, resolveLocation, parseCsv, splitList, OUTCOMES }
