import crypto from 'node:crypto'
import { ValidationError } from './errors.js'

/**
 * Authentication domain rules.
 *
 * Password hashing uses scrypt from node:crypto rather than bcrypt or argon2.
 * The reason is deployment, not cryptography: this is a native module, it
 * ships with every supported Node build, and it needs no compiler on a
 * machine that is trying to run a local intelligence platform. scrypt is a
 * memory-hard KDF, which is the property that actually matters here.
 */

export const ROLES = Object.freeze(['admin', 'editor', 'analyst', 'viewer'])

/**
 * Role capabilities.
 *
 * A single table rather than scattered `if` checks, so that adding a role forces
 * an explicit decision about every capability instead of silently inheriting
 * whatever the code happened to do for unknown roles.
 */
export const CAPABILITIES = Object.freeze({
  admin: [
    'business:read', 'business:write', 'business:verify',
    'request:read', 'request:write', 'request:moderate',
    'analytics:read', 'lab:read', 'lab:write',
    'user:read', 'user:write', 'import:read', 'import:write',
    'opportunity:read', 'opportunity:write',
    // Extending the reference trees is what makes a rejected import row
    // fixable, so it travels with import:write rather than sitting behind
    // user:write. The trees are shared vocabulary: a category or division added
    // here changes what every other role sees in search and every count.
    'reference:write',
  ],
  editor: [
    'business:read', 'business:write', 'business:verify',
    'request:read', 'request:write', 'request:moderate',
    'analytics:read', 'lab:read',
    'import:read', 'import:write',
    'opportunity:read',
    'reference:write',
  ],
  analyst: [
    'business:read', 'request:read',
    'analytics:read', 'lab:read', 'opportunity:read',
  ],
  viewer: ['business:read', 'analytics:read'],
})

export const SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
})

export function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw new ValidationError(`Unknown role "${role}".`, { allowed: ROLES })
  }
  return role
}

export function can(role, capability) {
  const granted = CAPABILITIES[role]
  return Array.isArray(granted) && granted.includes(capability)
}

export function assertPasswordStrength(password, minLength = 12) {
  if (typeof password !== 'string' || password.length < minLength) {
    throw new ValidationError(
      `Password must be at least ${minLength} characters.`,
      { field: 'password', minLength },
    )
  }
  if (password.length > 512) {
    throw new ValidationError('Password must be at most 512 characters.', {
      field: 'password',
    })
  }
  if (new Set(password).size < 8) {
    throw new ValidationError(
      'Password must use at least 8 distinct characters.',
      { field: 'password' },
    )
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password))
  if (classes.length < 3) {
    throw new ValidationError(
      'Password must combine at least three of: lowercase, uppercase, digits, symbols.',
      { field: 'password' },
    )
  }
  return password
}

/** Returns `scrypt$N$r$p$salt$hash`, all base64url. */
export function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  })
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64, 'base64url')
    const expected = Buffer.from(hashB64, 'base64url')
    const derived = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })
    return crypto.timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

export function needsRehash(stored, params = SCRYPT_PARAMS) {
  if (typeof stored !== 'string') return true
  const [scheme, N, r, p] = stored.split('$')
  if (scheme !== 'scrypt') return true
  return Number(N) < params.N || Number(r) < params.r || Number(p) < params.p
}

/** The only identifier we ever put in a session cookie. */
export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * HMACs an opaque token with the installation secret.
 *
 * Named for what it is rather than what it is used for: the same construction
 * covers session cookies, password resets and the marketplace's anonymous
 * request tokens, and all three are "random string in, non-reversible lookup key
 * out". Nothing here is a password hash and must never be used as one, because an
 * HMAC is fast to compute.
 */
export function hashOpaqueToken(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('base64url')
}

export function hashSessionToken(token, secret) {
  return hashOpaqueToken(token, secret)
}

/** Constant-time comparison of two hex/base64url digests. */
export function digestsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}
