import crypto from 'node:crypto'

/**
 * Identifier and slug rules.
 *
 * Slugs are part of the public URL contract, so their generation is a domain
 * rule rather than a per-endpoint detail. Two different businesses named
 * "Bright Future Bakery" must be able to coexist at
 * /business/bright-future-bakery and /business/bright-future-bakery-2.
 */

const MAX_SLUG_LENGTH = 80

export function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string')
  }
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'untitled'
}

/**
 * Produces a candidate slug. The uniqueness check itself needs the data layer,
 * so the caller resolves collisions by passing the candidate back through this
 * function with an incremented suffix. Keeping the collision loop here means
 * every caller produces identical suffixes for identical inputs.
 */
export function disambiguateSlug(base, attempt = 1) {
  const root = slugify(base)
  if (attempt <= 1) return root
  const suffix = `-${attempt}`
  const trimmed = root.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '')
  return `${trimmed}${suffix}`
}

export function newId() {
  return crypto.randomUUID()
}

/** Opaque, non-reversible token for password reset and email verification. */
export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function isValidId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value)
}

/**
 * Normalises a Ugandan phone number to its canonical international form.
 * Accepts the local formats people actually type: 07..., 01..., +2567...,
 * 2567..., and tolerates spaces, dashes and brackets.
 */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/[^\d+]/g, '')

  let national
  if (digits.startsWith('+256')) {
    national = digits.slice(4)
  } else if (digits.startsWith('256') && digits.length >= 12) {
    national = digits.slice(3)
  } else if (digits.startsWith('0')) {
    national = digits.slice(1)
  } else {
    national = digits
  }

  national = national.replace(/[^\d]/g, '')
  if (national.length < 9 || national.length > 10) return null
  if (!/^(7|2)\d{8}$/.test(national)) return null
  return `+256${national}`
}

export function isValidPhone(raw) {
  return normalisePhone(raw) !== null
}

export function normaliseUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.')) return null
    return url.toString()
  } catch {
    return null
  }
}
