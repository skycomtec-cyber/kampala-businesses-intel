/**
 * Response shapes and query coercion.
 *
 * Every endpoint in the api layer answers with the same envelope, because the
 * brief requires that the engine be usable from a website, a phone app and an AI
 * assistant without any of them having to guess. Success is `{ data, meta }`,
 * failure is `{ error }`, and a list always carries its pagination in `meta`
 * rather than in the body where a client might mistake it for data.
 */

import { ValidationError } from '../../core/errors.js'

/** A single record. `meta` stays out of the way when there is nothing to say. */
export function single(data, meta) {
  return meta ? { data, meta } : { data }
}

/**
 * A page of records.
 *
 * `total` is the count before paging, so a client can render "showing 1-25 of
 * 340" without a second request, and `hasMore` is what the infinite-scroll
 * callers actually branch on.
 */
export function collection(items, { total, limit, offset }) {
  return {
    data: items,
    meta: {
      total,
      limit,
      offset,
      count: items.length,
      hasMore: offset + items.length < total,
    },
  }
}

/**
 * A page built from whatever the repository returned.
 *
 * The repositories return either an array or `{ items, total }` depending on
 * whether the total was cheap to get, so the api layer normalises here rather
 * than making every route remember which shape it holds.
 */
export function paged(result, page) {
  const items = Array.isArray(result) ? result : result.items
  const total = Array.isArray(result) ? items.length : result.total
  return collection(items, { total, limit: page.limit, offset: page.offset })
}

const INTEGER = /^-?\d+$/

/** Query strings carry text, so numbers and booleans have to be read explicitly. */
export function toInteger(value, field, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`${field} must be a whole number.`, { field })
  }
  if (min !== null && parsed < min) {
    throw new ValidationError(`${field} must be at least ${min}.`, { field })
  }
  if (max !== null && parsed > max) {
    throw new ValidationError(`${field} must be at most ${max}.`, { field })
  }
  return parsed
}

export function toBoolean(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'boolean') return value
  const normalised = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false
  throw new ValidationError(`${field} must be true or false.`, { field })
}

/** Trims and drops empties, so `?q=&location=` behaves like the parameters are absent. */
export function toText(value, { maxLength = 200 } = {}) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > maxLength) {
    throw new ValidationError(`Value must be at most ${maxLength} characters.`, {
      field: 'value',
    })
  }
  return text
}

/** `?limit=25&offset=50` with the caps the repositories expect. */
export function toPage(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const limit = toInteger(query.limit, 'limit', { min: 1, max: maxLimit })
  const offset = toInteger(query.offset, 'offset', { min: 0 })
  return {
    limit: limit ?? defaultLimit,
    offset: offset ?? 0,
  }
}

/** Accepts either a repeated parameter or a comma-separated list. */
export function toList(value) {
  if (value === undefined || value === null || value === '') return null
  const items = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim())
    .filter(Boolean)
  return items.length > 0 ? items : null
}

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/** Shared param schema for anything addressed by id. */
export const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: uuidPattern } },
}

export const paginationQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
}

export { INTEGER }
