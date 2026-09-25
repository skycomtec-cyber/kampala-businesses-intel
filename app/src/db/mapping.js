/**
 * Row and value mapping.
 *
 * SQL speaks snake_case; the rest of the platform speaks camelCase. Converting in
 * one place, rather than aliasing every column in every query, keeps the
 * statements readable and means a column rename is a one-line change here
 * instead of an audit of every `SELECT` in the codebase.
 */

const BOOLEAN_TRUE = new Set([1, '1', true, 'true'])

export function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase())
}

export function camelToSnake(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export function camelizeRow(row) {
  if (!row) return row
  const result = {}
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value
  }
  return result
}

export function camelizeRows(rows) {
  return rows.map(camelizeRow)
}

/**
 * `camelize` is for rows that contain JSON columns. The JSON keys themselves are
 * left alone, because those are already authored in camelCase by the writers.
 */
export function camelizeJsonRow(row, jsonColumns = []) {
  const camel = camelizeRow(row)
  for (const column of jsonColumns) {
    const key = snakeToCamel(column)
    if (key in camel) camel[key] = parseJson(camel[key])
  }
  return camel
}

export function camelizeJsonRows(rows, jsonColumns = []) {
  return rows.map((row) => camelizeJsonRow(row, jsonColumns))
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function toJson(value) {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

/** SQLite has no boolean type; these keep the conversion honest in one place. */
export function toSqlBool(value) {
  if (value === null || value === undefined) return null
  return BOOLEAN_TRUE.has(value) ? 1 : 0
}

export function fromSqlBool(value) {
  if (value === null || value === undefined) return null
  return value === 1 || value === '1'
}

/**
 * SQLite's `CURRENT_TIMESTAMP` has second resolution and no zone marker, which
 * makes stored timestamps disagree with the ISO strings the platform generates
 * elsewhere. Every timestamp is therefore written by us, in one format.
 */
export function nowIso() {
  return new Date().toISOString()
}

export function isoDaysAgo(days, from = new Date()) {
  return new Date(from.getTime() - days * 86400000).toISOString()
}

export function toDayString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().slice(0, 10)
}

export function dayStringDaysAgo(days, from = new Date()) {
  return toDayString(isoDaysAgo(days, from))
}

/** Removes undefined values so a partial update does not null out a column. */
export function compact(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export function placeholders(count) {
  return new Array(count).fill('?').join(', ')
}
