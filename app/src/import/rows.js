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

  // Walk from the root of whatever suffix was given. Dropping leading segments
  // is what lets "Kampala/Nakawa Division" work without the operator repeating
  // the country every row.
  const all = app.locations.list({ limit: 10000 }).items
  const byName = groupBy(all, (row) => row.name.toLowerCase())
  const bySlug = groupBy(all, (row) => row.slug)

  for (let start = 0; start < segments.length; start += 1) {
    const chain = segments.slice(start)
    let parentId = null
    let node = null
    for (const segment of chain) {
      const key = segment.toLowerCase()
      const candidates = (byName.get(key) ?? []).filter((row) => row.parentId === parentId)
      const bySegmentSlug = (bySlug.get(slugify(segment)) ?? []).filter(
        (row) => row.parentId === parentId,
      )
      const matches = candidates.length > 0 ? candidates : bySegmentSlug
      if (matches.length !== 1) break
      node = matches[0]
      parentId = node.id
    }
    if (node) return node
  }

  // A bare name that is unique anywhere in the tree is unambiguous enough.
  const loose = byName.get(segments[segments.length - 1].toLowerCase()) ?? []
  if (loose.length === 1) return loose[0]

  if (loose.length > 1) {
    throw new ValidationError(
      `"${raw}" matches ${loose.length} locations (${loose
        .map((row) => row.name)
        .join(', ')}). Give the path, e.g. "Kampala/Nakawa Division".`,
      { field: 'location' },
    )
  }
  throw new ValidationError(
    `"${raw}" is not a location in the reference data. Add it with the admin api first, ` +
      'or check the spelling against GET /api/v1/locations.',
    { field: 'location' },
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
    if (byPath) return byPath
  }

  const exactPath = all.find((row) => row.pathSlugs === slugify(raw))
  if (exactPath) return exactPath

  const last = segments[segments.length - 1].toLowerCase()
  const byName = all.filter((row) => row.name.toLowerCase() === last)
  if (byName.length === 1) return byName[0]

  const bySlug = all.filter((row) => row.slug === slugify(segments[segments.length - 1]))
  if (bySlug.length === 1) return bySlug[0]

  if (byName.length > 1) {
    throw new ValidationError(
      `"${raw}" matches ${byName.length} categories (${byName
        .map((row) => row.pathSlugs)
        .join(', ')}). Use the full path, e.g. "services/beauty-and-personal-care/barbering".`,
      { field: 'category' },
    )
  }
  throw new ValidationError(
    `"${raw}" is not a category in the reference data. Check it against GET /api/v1/categories, ` +
      'or add it with the admin api first.',
    { field: 'category' },
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

  return { input, contacts, services, category, location }
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
