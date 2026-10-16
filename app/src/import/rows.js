/**
 * Turning a spreadsheet row into a listing.
 *
 * The importer's whole difficulty is that an operator writes "Kampala" and
 * "Nakawa Division" and "services/beauty-and-personal-care/barbering" in a
 * spreadsheet, while the database speaks in UUIDs. Resolution therefore has to
 * be forgiving about how a human names a place, and precise about what it
 * accepts, because a row that silently resolves to the wrong division is a
 * listing that will quietly distort every supply count computed from it.
 *
 * Every failure carries the source line and the offending value, because the
 * person who has to fix it is looking at a spreadsheet, not at this code.
 */

import { ValidationError } from '../core/errors.js'
import { normalisePhone, slugify } from '../core/identifiers.js'
import { splitList } from './csv.js'
import {
  CONTACT_KINDS,
  assertBusinessStatus,
  assertVerificationState,
} from '../core/business.js'
import { assertCapabilityLevel } from '../core/taxonomy.js'

/**
 * The column contract.
 *
 * Required columns are the three a listing cannot exist without. Everything
 * else is optional and defaults to the platform's own conservative choice, so a
 * minimal spreadsheet of three columns still imports.
 */
export const IMPORT_COLUMNS = Object.freeze({
  required: ['name', 'category', 'location'],
  optional: [
    'description',
    'address',
    'latitude',
    'longitude',
    'phone',
    'whatsapp',
    'email',
    'website',
    'facebook',
    'services',
    'skills',
    'founded_year',
    'status',
    'verification_state',
    'capability_level',
    'source',
    'external_ref',
    'evidence',
  ],
})

/**
 * Resolves a location the way an operator writes one.
 *
 * Accepts, in order of preference: a UUID pasted from the API; a full path
 * ("Uganda/Central Region/Kampala District/Kampala/Nakawa Division"); a
 * trailing part of that path ("Kampala/Nakawa Division", which is what someone
 * working in one city actually writes); or a bare name, which resolves only if
 * that name is unique across the whole tree. The last rule is the important
 * one: "Kampala" is both a city and part of a district name, so a bare name that
 * matched several nodes would place a listing somewhere the operator did not
 * say, and a wrong location is worse than a rejected row.
 */
export function resolveLocation(app, value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    throw new ValidationError('A location is required.', { field: 'location' })
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    const byId = app.locations.findById(raw)
    if (!byId) {
      throw new ValidationError(`No location has the id "${raw}".`, { field: 'location' })
    }
    return byId
  }

  const segments = raw
    .split(/[/>|]/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  // Walk the segments down the tree, allowing the chain to begin at any node
  // rather than only at a root. That is what lets "Kampala/Nakawa Division" work
  // without the operator repeating the country on every row, and it is also the
  // only way a path can be honoured once the tree has two "Kampala"s in it: a
  // bare name is ambiguous, a path is not.
  const all = app.locations.list({ limit: 10000 }).items
  const byName = groupBy(all, (row) => row.name.toLowerCase())
  const bySlug = groupBy(all, (row) => row.slug)

  const matchesIn = (index, segment, parentId) => {
    const named = (byName.get(segment.toLowerCase()) ?? []).filter(
      (row) => row.parentId === parentId,
    )
    if (named.length > 0) return named
    return (bySlug.get(slugify(segment)) ?? []).filter((row) => row.parentId === parentId)
  }
  const headsFor = (segment) => {
    const named = byName.get(segment.toLowerCase()) ?? []
    return named.length > 0 ? named : (bySlug.get(slugify(segment)) ?? [])
  }

  // The attempt that got furthest, kept so a rejected row can say where the
  // operator was trying to put the place rather than only that it is missing.
  let best = null
  const complete = []

  for (let start = 0; start < segments.length; start += 1) {
    const chain = segments.slice(start)
    for (const head of headsFor(chain[0])) {
      let node = head
      let resolved = 1
      for (let index = 1; index < chain.length; index += 1) {
        const matches = matchesIn(index, chain[index], node.id)
        if (matches.length !== 1) {
          if (
            !best ||
            resolved > best.resolved ||
            (resolved === best.resolved && start > best.start)
          ) {
            best = { resolved, start, node, missingName: chain[index] }
          }
          break
        }
        node = matches[0]
        resolved += 1
      }
      if (resolved === chain.length) complete.push(node)
    }
  }

  // The same node is reached by several of the attempts above, since every
  // suffix of "Kampala/Nakawa Division" walks down to the same place. Deduplicated
  // by id, that is one answer rather than five.
  const distinct = [...new Map(complete.map((row) => [row.id, row])).values()]
  if (distinct.length === 1) return distinct[0]

  if (distinct.length > 1) {
    throw new ValidationError(
      `"${raw}" matches ${distinct.length} locations (${distinct
        .map((row) => row.pathNames)
        .join('; ')}). Give the path, e.g. "Kampala/Nakawa Division".`,
      { field: 'location' },
    )
  }

  throw new ValidationError(
    `"${raw}" is not a location in the reference data. It is listed under ` +
      '"unresolved" in the import result, which can be sent straight to ' +
      'POST /api/v1/admin/reference/locations/bulk.',
    {
      field: 'location',
      reference: {
        type: 'location',
        value: raw,
        name: best?.missingName ?? segments[segments.length - 1],
        parentId: best?.node?.id ?? null,
        parentPath: best?.node?.pathNames ?? null,
      },
    },
  )
}

/**
 * Resolves a category, accepting a path slug, a name, or a UUID.
 *
 * The taxonomy's own path slugs are what the seeder uses, so a spreadsheet
 * built from the same vocabulary needs no translation. A bare name has to be
 * unique, for the same reason a bare location name does.
 */
export function resolveCategory(app, value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    throw new ValidationError('A category is required.', { field: 'category' })
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    const byId = app.categories.findById(raw)
    if (!byId) {
      throw new ValidationError(`No category has the id "${raw}".`, { field: 'category' })
    }
    return byId
  }

  const all = app.categories.all()
  const segments = raw.split(/[/>|]/).map((segment) => segment.trim()).filter(Boolean)

  if (segments.length > 1) {
    const path = segments.map(slugify).join('/')
    const byPath = all.find((row) => row.pathSlugs === path)
    if (byPath) return requireLeaf(app, byPath, raw)
  }

  const exactPath = all.find((row) => row.pathSlugs === slugify(raw))
  if (exactPath) return requireLeaf(app, exactPath, raw)

  const last = segments[segments.length - 1].toLowerCase()
  const byName = all.filter((row) => row.name.toLowerCase() === last)
  if (byName.length === 1) return requireLeaf(app, byName[0], raw)

  const bySlug = all.filter((row) => row.slug === slugify(segments[segments.length - 1]))
  if (bySlug.length === 1) return requireLeaf(app, bySlug[0], raw)

  if (byName.length > 1) {
    throw new ValidationError(
      `"${raw}" matches ${byName.length} categories (${byName
        .map((row) => row.pathSlugs)
        .join(', ')}). Use the full path, e.g. "services/beauty-and-personal-care/barbering".`,
      { field: 'category' },
    )
  }

  // The best guess at where the operator was heading, so the rejection says
  // which parent the new category belongs under rather than only its name.
  const parentPath = segments.slice(0, -1).map(slugify).join('/')
  const parent = parentPath
    ? all.find((row) => row.pathSlugs === parentPath) ?? null
    : null

  throw new ValidationError(
    `"${raw}" is not a category in the reference data. It is listed under ` +
      '"unresolved" in the import result, which can be sent straight to ' +
      'POST /api/v1/admin/reference/categories/bulk.',
    {
      field: 'category',
      reference: {
        type: 'category',
        value: raw,
        name: segments[segments.length - 1],
        parentId: parent?.id ?? null,
        parentPath: parent?.pathSlugs ?? null,
      },
    },
  )
}

/**
 * A business belongs in a leaf.
 *
 * A listing filed against a category that still has children is counted in the
 * supply rollup for that node and for its parent, so "barbering" and "beauty and
 * personal care" would both gain one business from a single shop, and the gap
 * engine would read two trades where there is one. Rejecting the row keeps the
 * tree honest; adding the missing child is one call.
 */
function requireLeaf(app, category, raw) {
  if (app.categories.children(category.id).length === 0) return category
  const children = app.categories.children(category.id).map((row) => row.name).join(', ')
  throw new ValidationError(
    `"${raw}" resolves to "${category.pathSlugs}", which has child categories (${children}). ` +
      'A business has to be filed under a leaf, e.g. ' +
      `"${category.pathSlugs}/${children.split(', ')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')}".`,
    {
      field: 'category',
      reference: {
        type: 'category_branch',
        value: raw,
        name: null,
        parentId: category.id,
        parentPath: category.pathSlugs,
        children,
      },
    },
  )
}

/**
 * Validates one row into the shape businesses.create expects.
 *
 * Returns the input plus a resolved categoryId/locationId, so the caller never
 * has to know that a spreadsheet speaks in names while the repository speaks in
 * ids. Throws ValidationError with a field, which the caller turns into a
 * line-numbered report entry.
 */
export function buildImportRow(app, row) {
  const name = String(row.name ?? '').trim()
  if (name.length < 2 || name.length > 160) {
    throw new ValidationError('A business name must be 2 to 160 characters.', {
      field: 'name',
    })
  }

  const category = resolveCategory(app, row.category)
  const location = resolveLocation(app, row.location)

  const input = {
    name,
    categoryId: category.id,
    locationId: location.id,
    sourceId: clean(row.source) ?? 'import:csv',
  }

  const description = clean(row.description)
  if (description) input.description = description

  const address = clean(row.address)
  if (address) input.addressText = address

  const latitude = optionalNumber(row.latitude, 'latitude', -90, 90)
  if (latitude !== null) input.latitude = latitude
  const longitude = optionalNumber(row.longitude, 'longitude', -180, 180)
  if (longitude !== null) input.longitude = longitude

  const foundedYear = optionalInteger(row.founded_year, 'founded_year', 1800, 2100)
  if (foundedYear !== null) input.foundedYear = foundedYear

  if (row.status) input.status = assertBusinessStatus(String(row.status).trim())
  if (row.verification_state) {
    input.verificationState = assertVerificationState(
      String(row.verification_state).trim(),
    )
  }
  if (row.capability_level) {
    input.capabilityLevel = assertCapabilityLevel(String(row.capability_level).trim())
  }

  // Contacts are collected here rather than in the repository because the CSV
  // decides the kind, and a website is a website in a spreadsheet but a field
  // on the business row as well. Both are written; the business column keeps the
  // public profile working, and the contact rows feed deduplication.
  const contacts = collectContacts(row)
  const website = contacts.find((contact) => contact.kind === 'website')
  if (website) input.website = website.value

  const skills = splitList(row.skills)
  if (skills.length > 0) input.skills = skills

  const services = splitList(row.services)
  if (services.length > 20) {
    throw new ValidationError('A row may list at most 20 services.', {
      field: 'services',
    })
  }

  return {
    input,
    contacts,
    services,
    category,
    location,
    externalRef: clean(row.external_ref),
    // Per-row, because a harvest reads each record off a different page and the
    // page is the thing a reviewer checks. Falls back to the run-level evidence
    // in the importer, so a plain spreadsheet is unaffected.
    evidence: clean(row.evidence),
  }
}

/**
 * Reads the contact columns into the shapes the repository validates.
 *
 * Two things are worth catching here rather than in the repository, because both
 * come from the same place: a spreadsheet whose columns were shifted by one.
 *
 * A phone number in the website column is the dangerous one. It is a perfectly
 * valid number, and the url normaliser would turn "0772111222" into
 * "https://7.232.146.146/", which is then published on a live listing as the
 * business's website. A rejected row costs an operator thirty seconds; a live
 * listing pointing at somebody else's server costs the directory its credibility.
 *
 * The same value repeated in two columns is dropped rather than written twice.
 */
function collectContacts(row) {
  const columns = [
    { column: 'phone', kind: 'phone' },
    { column: 'whatsapp', kind: 'whatsapp' },
    { column: 'email', kind: 'email' },
    { column: 'website', kind: 'website' },
    { column: 'facebook', kind: 'facebook' },
  ]

  const contacts = []
  const seen = new Set()
  for (const { column, kind } of columns) {
    const value = clean(row[column])
    if (!value) continue
    if (!CONTACT_KINDS.includes(kind)) {
      throw new ValidationError(`Unknown contact kind "${kind}".`, { field: 'contact_kind' })
    }
    if (URL_KINDS.has(kind) && normalisePhone(value)) {
      throw new ValidationError(
        `"${value}" in the ${column} column is a phone number, not a web address. ` +
          'If the columns are shifted, put it in phone or whatsapp.',
        { field: column },
      )
    }
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    contacts.push({
      kind,
      value,
      // A collected phone number is not published until somebody has checked it
      // belongs to this business, which is the platform's rule for any contact
      // added by an operator rather than confirmed by the business itself.
      isPublic: false,
      isPrimary: kind === 'phone',
    })
  }
  return contacts
}

const URL_KINDS = new Set(['website', 'facebook', 'tiktok'])

function clean(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Numbers are read as text because a spreadsheet column is text, and the message
 * names the column. "is not a number" without a column name is useless to
 * somebody looking at a report of four hundred rows.
 */
function optionalNumber(value, field, min, max) {
  const raw = clean(value)
  if (raw === null) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`The ${field} column has "${raw}", which is not a number.`, {
      field,
    })
  }
  if (parsed < min || parsed > max) {
    throw new ValidationError(
      `The ${field} column has "${raw}", which is outside the allowed range ${min} to ${max}.`,
      { field },
    )
  }
  return parsed
}

function optionalInteger(value, field, min, max) {
  const parsed = optionalNumber(value, field, min, max)
  if (parsed === null) return null
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`The ${field} column has "${value}", which is not a whole number.`, {
      field,
    })
  }
  return parsed
}

function groupBy(rows, keyOf) {
  const grouped = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(row)
    else grouped.set(key, [row])
  }
  return grouped
}
