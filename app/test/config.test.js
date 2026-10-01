import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, APP_ROOT } from '../src/config.js'

/**
 * A retention window that can be set to zero is a window that deletes the data it
 * governs. Nothing downstream re-checks one, so a typo here is not caught at the
 * point of use the way a bad k-threshold is - it is caught by the next
 * maintenance run, which reports success having emptied the demand history.
 *
 * `loadConfig` is called with a temp dataDir because it creates the directory, and
 * with env applied by the caller because that is the surface an operator
 * actually types into.
 */
function configWithEnv(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-config-'))
  const previous = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'c.db') })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('a retention window is never allowed to be zero or negative', () => {
  // The failure this guards against is silent: a window of 0 makes every row look
  // expired the moment it is written, so the purge deletes everything and exits 0.
  for (const bad of ['0', '-5', '-1', 'NaN', 'abc', 'null', '']) {
    const config = configWithEnv({
      KIP_RAW_SEARCH_RETENTION_DAYS: bad,
      KIP_EVENT_RETENTION_DAYS: bad,
    })
    assert.ok(
      config.privacy.rawSearchRetentionDays >= 1,
      `raw retention from ${JSON.stringify(bad)} should fall back to a usable window`,
    )
    assert.ok(
      config.privacy.eventRetentionDays >= 1,
      `event retention from ${JSON.stringify(bad)} should fall back to a usable window`,
    )
  }
})

test('a retention window does not silently truncate a number it half understands', () => {
  // parseInt('1e9') is 1. An operator asking for a billion days would get one
  // day and a platform that deletes its history on the next run.
  const config = configWithEnv({
    KIP_RAW_SEARCH_RETENTION_DAYS: '30d',
    KIP_EVENT_RETENTION_DAYS: '1e9',
  })
  assert.equal(config.privacy.rawSearchRetentionDays, 30, '30d is not a number, so it falls back')
  assert.equal(
    config.privacy.eventRetentionDays,
    1_000_000_000,
    '1e9 is a number and must not be truncated to 1',
  )
})

test('identifying text cannot be configured to outlive the aggregate it belongs to', () => {
  // The schema cannot honour this: search_query_raw cascades from search_event, so
  // the text dies with the event whatever its own expires_at says. Accepting the
  // request without correcting it is what made KIP_RAW_SEARCH_RETENTION_DAYS a
  // knob that did nothing.
  const config = configWithEnv({
    KIP_RAW_SEARCH_RETENTION_DAYS: '365',
    KIP_EVENT_RETENTION_DAYS: '30',
  })
  assert.equal(config.privacy.rawSearchRetentionDays, 30)
  assert.equal(config.privacy.eventRetentionDays, 30)
  assert.ok(
    config.privacy.rawSearchRetentionDays <= config.privacy.eventRetentionDays,
    'the reported value has to be the value the rows actually get',
  )
})

test('a longer event window is left alone, because the cascade permits it', () => {
  // The asymmetry is the point: text goes first, aggregates are kept for the trend
  // work. Widening the event window must not drag the raw window up with it.
  const config = configWithEnv({
    KIP_RAW_SEARCH_RETENTION_DAYS: '7',
    KIP_EVENT_RETENTION_DAYS: '400',
  })
  assert.equal(config.privacy.rawSearchRetentionDays, 7)
  assert.equal(config.privacy.eventRetentionDays, 400)
})

test('.env.example documents every variable the config reads, and nothing else', () => {
  // The example file is the only place an operator is told what can be configured,
  // so it drifts from src/config.js the moment either changes. Two directions
  // matter and they fail differently:
  //
  // A variable in config.js that the example never mentions is a setting nobody
  // will ever find, and one that may well be the k-anonymity floor.
  //
  // A variable in the example that config.js does not read is worse. It looks
  // authoritative, an operator sets it, and nothing changes - and if it was a
  // privacy setting, nothing says it did not take effect.
  const example = fs.readFileSync(path.join(APP_ROOT, '.env.example'), 'utf8')

  // Two sets, because a commented-out line and a live line mean different things.
  // `mentioned` is anything the file talks about; `active` is what gets applied if
  // you copy the file as-is. Secrets and one-shot commands are mentioned and left
  // commented, which is the whole reason for the distinction.
  const mentioned = new Set()
  const active = new Set()
  for (const rawLine of example.split(/\r?\n/)) {
    const line = rawLine.trim()
    const body = line.startsWith('#') ? line.replace(/^#+\s*/, '') : line
    if (!body) continue
    const eq = body.indexOf('=')
    if (eq === -1) continue
    const key = body.slice(0, eq).trim()
    if (!key.startsWith('KIP_')) continue
    mentioned.add(key)
    if (!line.startsWith('#')) active.add(key)
  }

  // Read across the files that consult the environment, not just config.js. A few
  // settings are read directly because they are needed before the config object
  // exists - KIP_LOG_LEVEL builds the logger - and those are still settings an
  // operator is entitled to find documented.
  const readIn = new Set()
  for (const file of ['src/config.js', 'src/api/index.js']) {
    const source = fs.readFileSync(path.join(APP_ROOT, file), 'utf8')
    for (const key of source.match(/KIP_[A-Z0-9_]+/g) ?? []) readIn.add(key)
  }
  // Read by the CLI scripts, which the example documents in the admin section but
  // which loadConfig never sees.
  readIn.add('KIP_ADMIN_EMAIL')
  readIn.add('KIP_ADMIN_PASSWORD')
  readIn.add('KIP_ADMIN_NAME')

  for (const key of readIn) {
    assert.ok(mentioned.has(key), `${key} is read by the app but missing from .env.example`)
  }
  for (const key of active) {
    assert.ok(
      readIn.has(key),
      `${key} is set by .env.example but nothing in the app reads it, so it does nothing`,
    )
  }

  // And the ones that must not arrive pre-filled are commented and empty. An
  // operator who copies the file should never end up with a committed secret, and
  // these two are the only values in it that are secret rather than a setting. A
  // path like KIP_DB_FILE can ship an example value; a password cannot.
  for (const key of ['KIP_SESSION_SECRET', 'KIP_ADMIN_PASSWORD']) {
    for (const rawLine of example.split(/\r?\n/)) {
      const line = rawLine.trim()
      const body = line.startsWith('#') ? line.replace(/^#+\s*/, '') : line
      if (!body.startsWith(`${key}=`)) continue
      assert.ok(line.startsWith('#'), `${key} must be commented out, not applied on a plain copy`)
      assert.equal(
        body.slice(key.length + 1).trim(),
        '',
        `${key} must ship empty, not with a placeholder that looks like a value`,
      )
    }
  }
})

/**
 * The .env ordering, against a file of our own rather than the real one.
 *
 * `loadConfig` reads APP_ROOT/.env unless told otherwise, so a test that wrote the
 * real file would be mutating state every other test in the suite depends on -
 * and node --test runs the files concurrently. It passed alone and failed in the
 * full run for exactly that reason. So `envFile` overrides the path, which is also
 * what a deployment keeping configuration in /etc needs.
 */
function configFromDotEnv(contents, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-dotenv-'))
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, contents, 'utf8')

  const previous = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return loadConfig({ envFile })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('KIP_DATA_DIR in .env is honoured, not only in the environment', () => {
  // The one ordering trap in the config reader. Everything else can arrive late
  // because it is read at a single place, but the data directory decides where the
  // database, the session secret, the lock file and the backups live. Reading it
  // before .env was loaded means an operator who sets KIP_DATA_DIR in .env - the
  // documented way, and the only way the .env.example shows it - gets an install
  // that silently writes to ./data instead, and nothing says so.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-dotenv-data-'))
  try {
    const config = configFromDotEnv(
      [`KIP_DATA_DIR=${dir}`, 'KIP_PORT=4999', 'KIP_K_THRESHOLD=9', ''].join('\n'),
      { KIP_DATA_DIR: undefined, KIP_PORT: undefined, KIP_K_THRESHOLD: undefined },
    )

    assert.equal(config.dataDir, dir, 'the data directory comes from .env')
    assert.equal(config.port, 4999)
    assert.equal(config.privacy.kThreshold, 9)
    assert.equal(config.database.file, path.join(dir, 'kampala.db'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the real environment still beats .env', () => {
  // The other half. A systemd EnvironmentFile or a Compose env_file has to win over
  // a checked-out .env, or an operator who sets KIP_PORT in both has no way to tell
  // which one the server used.
  const config = configFromDotEnv('KIP_PORT=4999\n', { KIP_PORT: 5001 })
  assert.equal(config.port, 5001, 'the environment wins')
})

test('an operator override still beats .env', () => {
  // A systemd unit passes KIP_DATA_DIR in Environment= and also ships an
  // EnvironmentFile. Whichever the unit intends has to be the one in force.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-dotenv-override-'))
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, `KIP_DATA_DIR=${dir}\nKIP_PORT=4999\n`, 'utf8')
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-dotenv-override2-'))
  try {
    const config = loadConfig({ envFile, dataDir: elsewhere, port: 5002 })
    assert.equal(config.dataDir, elsewhere)
    assert.equal(config.port, 5002)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('retention is overridable without touching the process environment', () => {
  // kThreshold was already overridable this way and retention was not, which
  // meant the rules above could only be tested by mutating global state.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-config-'))
  try {
    const config = loadConfig({
      dataDir: dir,
      databaseFile: path.join(dir, 'c.db'),
      privacy: { rawSearchRetentionDays: 365, eventRetentionDays: 30 },
    })
    assert.equal(config.privacy.eventRetentionDays, 30)
    assert.equal(
      config.privacy.rawSearchRetentionDays,
      30,
      'an override that breaks the ordering is corrected the same way an env var is',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
