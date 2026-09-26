import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Runtime configuration.
 *
 * Every value is resolvable from the environment so the same build runs locally,
 * in a container, or on a server without code changes. Defaults are chosen so
 * that a fresh checkout boots with zero configuration.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = path.resolve(HERE, '..')

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

function readBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = raw.toLowerCase()
  if (TRUE_VALUES.has(value)) return true
  if (FALSE_VALUES.has(value)) return false
  return fallback
}

function readInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function readString(name, fallback) {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

/**
 * The session secret is the one value that must never silently fall back to a
 * constant. If it is missing we generate a random one and persist it next to
 * the database, so restarts do not invalidate every live session.
 */
function resolveSessionSecret(dataDir) {
  const fromEnv = process.env.KIP_SESSION_SECRET
  if (fromEnv && fromEnv.length >= 32) return fromEnv

  const secretFile = path.join(dataDir, '.session-secret')
  if (fs.existsSync(secretFile)) {
    const stored = fs.readFileSync(secretFile, 'utf8').trim()
    if (stored.length >= 32) return stored
  }

  const generated = crypto.randomBytes(48).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 })
  return generated
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  const contents = fs.readFileSync(file, 'utf8')
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir ?? readString('KIP_DATA_DIR', path.join(APP_ROOT, 'data')),
  )
  fs.mkdirSync(dataDir, { recursive: true })
  loadDotEnv(path.join(APP_ROOT, '.env'))

  const config = {
    env: readString('NODE_ENV', 'development'),
    host: readString('KIP_HOST', '127.0.0.1'),
    port: readInt('KIP_PORT', 4310),
    appRoot: APP_ROOT,
    dataDir,
    database: {
      // Phase 1 runs on SQLite + FTS5. The repository layer is the only place
      // that knows this, so a Postgres adapter can replace it without touching
      // the engine, api or web layers.
      driver: readString('KIP_DB_DRIVER', 'sqlite'),
      file: path.resolve(
        overrides.databaseFile ??
          readString('KIP_DB_FILE', path.join(dataDir, 'kampala.db')),
      ),
    },
    privacy: {
      // k-anonymity floor. Any aggregate computed over fewer than this many
      // distinct actors is suppressed before it can leave the engine.
      kThreshold: overrides.privacy?.kThreshold ?? readInt('KIP_K_THRESHOLD', 5),
      // Rotating salt for search/session pseudonymisation. Rotated daily so the
      // signals remain useful while individual actors stay unlinkable.
      rotationDays: readInt('KIP_ROTATION_DAYS', 1),
      // Hard retention floors, in days.
      rawSearchRetentionDays: readInt('KIP_RAW_SEARCH_RETENTION_DAYS', 180),
      eventRetentionDays: readInt('KIP_EVENT_RETENTION_DAYS', 90),
    },
    auth: {
      sessionSecret: resolveSessionSecret(dataDir),
      sessionTtlHours: readInt('KIP_SESSION_TTL_HOURS', 12),
      cookieName: readString('KIP_COOKIE_NAME', 'kip_session'),
      // Min password length enforced at the core layer.
      minPasswordLength: readInt('KIP_MIN_PASSWORD_LENGTH', 12),
    },
    api: {
      // Route prefix, so a future /api/v2 can be mounted beside this one instead
      // of breaking every mobile client at once.
      prefix: readString('KIP_API_PREFIX', '/api/v1'),
      // Reject oversized bodies before they are parsed. The largest legitimate
      // request here is a business profile with a few hundred characters of text.
      bodyLimit: readInt('KIP_BODY_LIMIT', 256 * 1024),
      // Only trust X-Forwarded-For when a proxy in front of us is actually
      // setting it. Left off, a client could spoof its own address and walk
      // straight past the rate limiter.
      trustProxy: readBool('KIP_TRUST_PROXY', false),
      /**
       * Fixed-window limits, in requests per window.
       *
       * Anonymous endpoints are the ones that cost the platform money and collect
       * the most signal per call, so they get the tightest ceilings. Sign-in is
       * limited per address precisely because it is the one endpoint worth
       * guessing at.
       */
      rateLimit: {
        search: { windowMs: 60_000, max: 30 },
        request: { windowMs: 60_000, max: 5 },
        signIn: { windowMs: 15 * 60_000, max: 10 },
        read: { windowMs: 60_000, max: 240 },
      },
    },
    seed: {
      // Reference data (administrative locations, taxonomy) is real-world
      // reference data, not synthetic content. Business content is never
      // seeded.
      reference: readBool('KIP_SEED_REFERENCE', true),
      /**
       * The one real organization, imported through the catalogue on every start.
       *
       * Separate from `reference` on purpose. The taxonomy is shared vocabulary
       * and belongs in every install; this is a single business record, and an
       * install that has outgrown the demonstration needs a switch that does not
       * involve editing code. It arrives `pending_review` and is never published
       * by the seed, so the only thing turning it off removes a queue item.
       */
      catalogueDemo: readBool('KIP_SEED_CATALOGUE_DEMO', true),
    },
  }

  if (Number.isInteger(overrides.port)) config.port = overrides.port
  if (overrides.host) config.host = overrides.host

  return Object.freeze(config)
}

export const config = loadConfig()
