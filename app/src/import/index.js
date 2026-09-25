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

import { parseCsv, toRecords, splitList } from './csv.js'
import { buildImportRow, resolveCategory, resolveLocation, IMPORT_COLUMNS } from './rows.js'
import { ValidationError, DomainError } from '../core/errors.js'
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
 * @param {object} app the open database handle and repositories
 * @param {string} text the file contents
 * @param {object} [options]
 * @param {boolean} [options.dryRun] validate and report without writing
 * @param {string} [options.sourceId] recorded on every created listing
 * @param {(progress: object) => void} [options.onRow] called per row, for a CLI
 * @returns {{ summary: object, rows: object[] }}
 */
export function importBusinessesFromCsv(app, text, options = {}) {
  const { dryRun = false, sourceId = 'import:csv', onRow = null } = options

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

  for (const [index, record] of records.entries()) {
    const line = lineOf[index]
    const outcome = { line, name: record.name ?? '', outcome: null, detail: null, id: null }

    try {
      const { input, contacts, services } = buildImportRow(app, record)
      if (sourceId && !record.source) input.sourceId = sourceId

      const duplicate = findDuplicate(app, { input, contacts, seenContacts, seenNames })
      if (duplicate) {
        outcome.outcome = 'skipped'
        outcome.detail = duplicate.reason
        outcome.id = duplicate.business.id
        summary.skipped += 1
      } else if (dryRun) {
        // In a dry run the row is counted as it would be created, but nothing is
        // written, and the name is still reserved so that a file with two
        // identical rows reports one created and one skipped.
        outcome.outcome = 'created'
        outcome.detail = 'would create'
        summary.created += 1
        reserve(seenNames, seenContacts, input, contacts)
      } else {
        const created = writeBusiness(app, input, contacts, services)
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

  return { summary, rows, unresolved: listUnresolved(unresolved) }
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
 */
function writeBusiness(app, input, contacts, services) {
  const write = app.db.transaction(() => {
    const created = app.businesses.create(input)
    for (const contact of contacts) {
      app.businesses.addContact(created.id, contact)
    }
    for (const name of services) {
      app.businesses.addService(created.id, { name })
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
