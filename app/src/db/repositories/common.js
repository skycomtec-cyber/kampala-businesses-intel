/**
 * Shared repository helpers.
 *
 * The one thing every repository needs and none of them should implement
 * differently: a safe way to turn a caller-supplied sort key into SQL. An
 * `ORDER BY ${sort}` built from a request parameter is an injection point, so
 * sorting is always declared as an allowlist here.
 */

export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 200

export function normalisePagination({ limit, offset } = {}) {
  const parsedLimit = Number.parseInt(limit, 10)
  const parsedOffset = Number.parseInt(offset, 10)
  return {
    limit: Number.isFinite(parsedLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, parsedLimit))
      : DEFAULT_LIMIT,
    offset: Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0,
  }
}

/**
 * Resolves `sort` against a declared allowlist.
 *
 * The allowlist values carry their own direction ("b.created_at DESC"), so the
 * mapping is a plain lookup and nothing from the caller ever reaches the SQL
 * text. The fallback is the first entry in the allowlist, so every query has a
 * deterministic order and a paginated list can never repeat or skip a row
 * because two rows compared equal on an unstable key.
 */
export function resolveOrder(sort, allowed, fallback) {
  const requested = Array.isArray(sort) ? sort[0] : sort
  return allowed[requested] ?? fallback
}

/** Joins already-safe conditions into a single WHERE fragment. */
export function where(conditions) {
  const active = conditions.filter(Boolean)
  if (active.length === 0) return ''
  return `WHERE ${active.join(' AND ')}`
}

export function likeParam(value) {
  return `%${String(value).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
