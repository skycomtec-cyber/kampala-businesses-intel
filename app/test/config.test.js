import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'

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
