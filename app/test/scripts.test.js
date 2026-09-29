import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

/**
 * The scheduled commands, tested the way the launcher runs them: as a child
 * process, against a data directory pointed at by the environment.
 *
 * These scripts are the only thing that has ever invoked the gap engine, so
 * "the engine works" and "the engine is ever run" are separate claims and this
 * file is the only thing that covers the second one. A green engine test suite
 * with a broken maintenance script is a platform that has never once computed a
 * gap.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const maintenance = path.join(appRoot, 'scripts', 'maintenance.js')
const analyse = path.join(appRoot, 'scripts', 'analyse.js')

function withDataDir(dataDir, callback) {
  const previous = process.env.KIP_DATA_DIR
  process.env.KIP_DATA_DIR = dataDir
  try {
    return callback()
  } finally {
    if (previous === undefined) delete process.env.KIP_DATA_DIR
    else process.env.KIP_DATA_DIR = previous
  }
}

function run(script, args, { dataDir }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, KIP_DATA_DIR: dataDir }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
  })
}

/**
 * A migrated database with one clear gap in it.
 *
 * Twelve distinct actors searching yesterday for something nobody in the index
 * serves: enough to clear the k-anonymity floor, and enough to produce a real
 * opportunity rather than a suppressed row.
 */
function freshDataDirWithDemand() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-sched-'))
  withDataDir(dataDir, () => {
    const app = openApp({ config: loadConfig() })

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
    app.close()
  })
  return dataDir
}

function readIntelligence(dataDir, callback) {
  return withDataDir(dataDir, () => {
    const app = openApp({ config: loadConfig() })
    try {
      return callback(app)
    } finally {
      app.close()
    }
  })
}

test('maintenance rolls demand up and then measures the gaps it rolled up', async () => {
  const dataDir = freshDataDirWithDemand()
  try {
    const result = await run(maintenance, ['--days', '3', '--no-purge'], { dataDir })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Rolled up/)

    readIntelligence(dataDir, (app) => {
      // The rollup ran...
      assert.ok(
        app.intelligence.latestRun('gaps'),
        'the engine is wired into the command that the launcher already runs',
      )
      const { items: gaps } = app.intelligence.gaps({ limit: 50 })
      assert.equal(gaps.length, 1)
      assert.equal(gaps[0].phrase, 'hydroponics')
      assert.equal(gaps[0].suppressed, false)
      assert.ok(gaps[0].gapScore > 0)

      // ...and so did the measurement, which is the part that did not happen
      // before the engine existed.
      const { items: opportunities } = app.intelligence.opportunities()
      assert.equal(opportunities.length, 1)
      assert.equal(opportunities[0].keyword, 'hydroponics')
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('maintenance can skip the engine, and the engine is not run anyway', async () => {
  const dataDir = freshDataDirWithDemand()
  try {
    const result = await run(maintenance, ['--no-gaps', '--no-purge'], { dataDir })
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /Gaps:/, 'the job reports itself or it does not run')
    assert.equal(
      readIntelligence(dataDir, (app) => app.intelligence.latestRun('gaps')),
      null,
      '--no-gaps means no run was recorded, not a run that measured nothing',
    )
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('maintenance is idempotent across repeated runs', async () => {
  const dataDir = freshDataDirWithDemand()
  try {
    await run(maintenance, ['--days', '3', '--no-purge'], { dataDir })
    await run(maintenance, ['--days', '3', '--no-purge'], { dataDir })

    readIntelligence(dataDir, (app) => {
      const { items: opportunities } = app.intelligence.opportunities()
      assert.equal(
        opportunities.length,
        1,
        'a second run refreshes the finding rather than appending a duplicate',
      )
      // Each run is still its own row: the run history is what makes a recompute
      // auditable, so it is deliberately not deduplicated the way opportunities are.
      assert.equal(app.intelligence.recentRuns(10).length, 2)
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('analyse reports what a run produced and honours its flags', async () => {
  const dataDir = freshDataDirWithDemand()
  try {
    await run(maintenance, ['--no-gaps', '--no-purge'], { dataDir })

    const result = await run(analyse, ['--top', '5'], { dataDir })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /\(completed\)/)
    assert.match(result.stdout, /hydroponics/)
    assert.match(result.stdout, /Largest gaps in this run/)

    // --window changes the window that was measured, which is the reason the
    // command exists separately from maintenance.
    const wide = await run(analyse, ['--window', '90'], { dataDir })
    assert.equal(wide.code, 0, wide.stderr)
    assert.match(wide.stdout, /over 90 day\(s\)/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
