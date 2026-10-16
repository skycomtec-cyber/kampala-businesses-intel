import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { ValidationError } from '../src/core/errors.js'
import { createScheduler, isRunDue } from '../src/ops/scheduler.js'

/**
 * The in-process scheduler, which is the whole of the nightly work on a platform
 * that has no systemd timer.
 *
 * Two claims are tested separately and both matter. The timing claim - when a run
 * is due - is pure and fixed against a clock. The doing claim is driven through a
 * real migrated database with a real gap in it, because a scheduler that decides
 * correctly and calls the wrong routine is a platform whose retention windows have
 * a schedule and no effect.
 */

const HOUR_MS = 3600000

/** A config as the server would resolve it, with the schedule switched on. */
function configFor(dataDir, ops = {}) {
  const base = loadConfig({ dataDir })
  return { ...base, ops: { enabled: true, intervalHours: 24, ...ops } }
}

/**
 * A migrated database with one clear gap in it: twelve distinct actors searching
 * yesterday for something nobody serves, enough to clear the k-anonymity floor.
 * The same fixture the scheduled-script tests use, because the jobs are the same.
 */
function openAppWithDemand(dataDir) {
  const app = openApp({ config: loadConfig({ dataDir }) })
  const city = app.locations.create({
    kind: 'country',
    name: 'Uganda',
    latitude: 1.3733,
    longitude: 32.5825,
  })
  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  yesterday.setUTCHours(9, 0, 0, 0)
  for (let index = 0; index < 12; index += 1) {
    app.demand.recordSearch({
      query: 'hydroponics',
      locationId: city.id,
      coverageLevel: 'city',
      totalResults: 0,
      actorSeed: `grower-${index}`,
      at: yesterday,
    })
  }
  return app
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kip-ops-'))
}

test('never run is due, and a recent run is not', () => {
  const now = new Date('2026-10-16T12:00:00.000Z')
  assert.equal(isRunDue({ lastRunAt: null, intervalHours: 24, now }), true)
  assert.equal(
    isRunDue({ lastRunAt: '2026-10-16T11:00:00.000Z', intervalHours: 24, now }),
    false,
    'an hour after a daily run, not due',
  )
  assert.equal(
    isRunDue({ lastRunAt: '2026-10-15T11:59:00.000Z', intervalHours: 24, now }),
    true,
    'a minute short of the interval is due',
  )
})

test('a malformed recorded time is treated as due, not as fresh', () => {
  const now = new Date('2026-10-16T12:00:00.000Z')
  assert.equal(isRunDue({ lastRunAt: 'not a date', intervalHours: 24, now }), true)
})

test('a nonsense interval is refused rather than silently used', () => {
  for (const bad of [0, -1, Number.NaN, null]) {
    assert.throws(
      () => isRunDue({ lastRunAt: null, intervalHours: bad }),
      ValidationError,
      `intervalHours ${bad} should be refused`,
    )
  }
})

test('a due run rolls up, measures gaps, enforces retention and takes a backup', async () => {
  const dataDir = tempDir()
  try {
    const app = openAppWithDemand(dataDir)
    try {
      const config = configFor(dataDir)
      const at = new Date('2026-10-16T03:17:00.000Z')
      const scheduler = createScheduler(app, config, { now: () => at, logger: () => {} })

      const result = await scheduler.checkNow()

      assert.ok(!result.skipped, 'a first run is due')
      assert.ok(result.maintenance, 'maintenance ran')
      assert.equal(result.maintenance.days, 2, 'rolled up the default window')
      assert.equal(result.errors.length, 0, result.errors.join('; '))

      // The engine ran, which is the part no request does.
      assert.ok(app.intelligence.latestRun('gaps'), 'the gap engine ran')
      const { items: opportunities } = app.intelligence.opportunities()
      assert.equal(opportunities.length, 1)
      assert.equal(opportunities[0].keyword, 'hydroponics')

      // ...and a backup was written and verified by createBackup.
      assert.ok(result.backup, 'a backup was taken')
      assert.ok(fs.existsSync(result.backup.file), 'the backup file is on disk')
      assert.ok(
        fs.existsSync(path.join(dataDir, 'backups')),
        'the backup went to the data directory',
      )

      // The run is recorded, so the next check can tell it already happened.
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, '.ops-state.json'), 'utf8'))
      assert.equal(state.lastRunAt, at.toISOString())
      assert.equal(state.lastError, null)
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a run that just happened is not due, and becomes due when the interval passes', async () => {
  const dataDir = tempDir()
  try {
    const app = openAppWithDemand(dataDir)
    try {
      const first = new Date('2026-10-16T03:17:00.000Z')
      let clock = first
      const config = configFor(dataDir, { intervalHours: 24 })
      const scheduler = createScheduler(app, config, { now: () => clock, logger: () => {} })

      await scheduler.checkNow()

      // Same moment: not due.
      const second = await scheduler.checkNow()
      assert.equal(second.skipped, true)
      assert.equal(second.reason, 'not-due')

      // An hour short of the interval: still not due.
      clock = new Date(first.getTime() + 23 * HOUR_MS)
      assert.equal((await scheduler.checkNow()).skipped, true)

      // The interval plus a minute: due again, and a second backup lands.
      clock = new Date(first.getTime() + 24 * HOUR_MS + 60000)
      const third = await scheduler.checkNow()
      assert.ok(!third.skipped, 'due again after a day')
      const backups = fs
        .readdirSync(path.join(dataDir, 'backups'))
        .filter((name) => name.endsWith('.db'))
      assert.equal(backups.length, 2, 'a second daily backup was written')
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a disabled schedule checks nothing and writes nothing', async () => {
  const dataDir = tempDir()
  try {
    const app = openAppWithDemand(dataDir)
    try {
      const config = configFor(dataDir, { enabled: false })
      const scheduler = createScheduler(app, config, { logger: () => {} })

      const result = await scheduler.checkNow()
      assert.equal(result.skipped, true)
      assert.equal(result.reason, 'disabled')
      assert.equal(
        fs.existsSync(path.join(dataDir, '.ops-state.json')),
        false,
        'nothing is written when the schedule is off',
      )
      assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false)
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
