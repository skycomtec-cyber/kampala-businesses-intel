import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

/**
 * The whole loop, run the way it actually runs.
 *
 * The engine tests call `runGapEngine` directly, which proves the scoring is
 * right but proves nothing about the thing that was actually broken. On the live
 * database, demand had been collected for weeks, two runs had completed, and both
 * had measured `searches_seen: 0` over a window that ended the day *before* the
 * only searches that existed. Every layer beneath the window was correct and
 * tested. The failure was in the join between them, and a test that calls the
 * engine in-process cannot see a join it makes itself.
 *
 * So these tests spawn `scripts/maintenance.js` as a real subprocess, against a
 * real database file, and assert on what it left behind. The three jobs in that
 * script have an ordering the unit tests each verify in isolation - roll up, then
 * measure, then purge - and the ordering is where the bug lived.
 */

const K = 5
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const MAINTENANCE = path.join(APP_ROOT, 'scripts', 'maintenance.js')

/** Today, in UTC, the same day string the rollup and the engine both key on. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * A temp database, opened and closeable.
 *
 * `reopen` is not a convenience: SQLite will not let a second connection read a
 * database the first still holds open on every platform, and the subprocess under
 * test needs the file to itself. The sequence the real system uses - a request
 * writes, the process is still running, the scheduled job opens the file - is
 * close/reopen/maintenance, so the test does that too.
 */
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-e2e-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'test.db'),
    privacy: { kThreshold: K },
  })
  let app = openApp({ config })
  let open = true

  return {
    get app() {
      return app
    },
    dir,
    close() {
      if (!open) return
      app.close()
      open = false
    },
    reopen() {
      if (open) return
      app = openApp({ config })
      open = true
    },
    cleanup() {
      if (open) app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The scheduled job, as the launcher runs it. */
function runMaintenance(dir, args = []) {
  return spawnSync(process.execPath, [MAINTENANCE, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KIP_DATA_DIR: dir,
      KIP_DB_FILE: path.join(dir, 'test.db'),
      KIP_K_THRESHOLD: String(K),
    },
  })
}

/** Reference scaffolding: Uganda > Central > Wakiso > Kampala. */
function seedReference(app) {
  const country = app.locations.create({
    kind: 'country',
    name: 'Uganda',
    latitude: 1.3733,
    longitude: 32.5825,
  })
  const region = app.locations.create({ kind: 'region', name: 'Central Region', parentId: country.id })
  const district = app.locations.create({
    kind: 'district',
    name: 'Wakiso District',
    parentId: region.id,
    externalCode: 'UG-041',
  })
  const city = app.locations.create({
    kind: 'city',
    name: 'Kampala',
    parentId: district.id,
    latitude: 0.3476,
    longitude: 32.5825,
  })
  return { country, region, district, city }
}

/** A published, searchable business: supply is only counted from published rows. */
function publishBusiness(app, { city, category, ...input }) {
  const business = app.businesses.create({
    categoryId: category.id,
    locationId: city.id,
    status: 'active',
    ...input,
  })
  app.businesses.review(business.id, { action: 'verify', reason: 'Checked.' })
  app.businesses.review(business.id, { action: 'approve', reason: 'Published.' })
  return business
}

/**
 * Records `count` searches for one phrase from `count` distinct actors, all on the
 * same day. The actor count matters: the k-anonymity floor is 5, so a phrase
 * searched four times is suppressed and never becomes an opportunity, and a test
 * that quietly tripped the floor would be testing privacy rather than the loop.
 */
function searchToday(app, { query, locationId, coverageLevel, count, prefix }) {
  for (let index = 0; index < count; index += 1) {
    app.demand.recordSearch({
      query,
      locationId,
      coverageLevel,
      totalResults: 0,
      actorSeed: `${prefix}-${index}`,
      at: new Date(),
    })
  }
}

test('the scheduled job measures demand that arrived today', () => {
  const h = harness()
  try {
    const { app } = h
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa each morning.',
    })
    searchToday(app, {
      query: 'granite worktop',
      locationId: city.id,
      coverageLevel: 'city',
      count: 12,
      prefix: 'stonecutter',
    })

    h.close()
    const result = runMaintenance(h.dir)

    assert.equal(result.status, 0, `maintenance failed:\n${result.stderr}`)
    assert.match(result.stdout, /Rolled up \d+ day\(s\)/, 'it rolled demand up before measuring')

    h.reopen()
    const run = h.app.intelligence.latestRun('gaps')
    assert.equal(run.windowEnd, today(), 'the run measured a window ending today')
    assert.equal(run.status, 'completed')

    const gaps = h.app.intelligence.gaps({ runId: run.id })
    const granite = gaps.items.find((row) => row.phrase === 'granite worktop')

    // This is the assertion that used to fail against the live database. Twelve
    // searches recorded today, measured today, and the engine reported none of
    // them, because the window ended yesterday and the day the searches were in
    // was not inside it. The count is the whole claim: not "a gap exists", but
    // "the gap is the one these twelve searches actually made".
    assert.ok(granite, "today's demand produced a gap")
    assert.equal(granite.searches, 12)
    assert.equal(granite.distinctActors, 12)
    assert.equal(granite.suppressed, false, '12 actors clears the floor of 5')
    assert.equal(granite.supplyCount, 0, 'the bakery does not sell granite')
  } finally {
    h.cleanup()
  }
})

test('a search today becomes an opportunity today, with no day of latency', () => {
  const h = harness()
  try {
    const { app } = h
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa each morning.',
    })
    searchToday(app, {
      query: 'granite worktop',
      locationId: city.id,
      coverageLevel: 'city',
      count: 12,
      prefix: 'stonecutter',
    })

    h.close()
    assert.equal(runMaintenance(h.dir).status, 0)
    h.reopen()

    // Note the field name: a gap row carries `phrase`, an opportunity row carries
    // `keyword` and counts demand as `estimatedMonthlySearches`. Both are the same
    // underlying fact about the same phrase, renamed as it was promoted.
    const opportunities = h.app.intelligence.opportunities({ state: 'candidate' })
    const granite = opportunities.items.find((row) => row.keyword === 'granite worktop')

    assert.ok(granite, 'the gap cleared the moderate floor and was promoted')
    assert.equal(granite.estimatedMonthlySearches, 12)
    assert.equal(granite.severity, 'critical')
    assert.equal(granite.supplyCount, 0)
    // `candidate` is the canonical first state, and the engine never sets one
    // itself. Asserting the literal here rather than reading it off the enum means
    // a future rename of the state machine fails this test loudly instead of
    // silently changing what the public list is filtered by.
    assert.equal(granite.state, 'candidate')

    // The supply series is written on the same day the run happened, which is what
    // makes the two halves of the loop joinable: demand on day D, supply on day D,
    // opportunity on day D. Before the window fix the supply row landed a day
    // before the demand it was being compared against.
    const supply = h.app.intelligence.supplySeries({
      locationId: city.id,
      categoryId: null,
      from: today(),
      to: today(),
    })
    assert.equal(supply.length, 1, 'the run measured supply for today')
    assert.equal(supply[0].businessCount, 1)
  } finally {
    h.cleanup()
  }
})

test('running the job twice leaves one opportunity, not two', () => {
  const h = harness()
  try {
    const { app } = h
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa each morning.',
    })
    searchToday(app, {
      query: 'granite worktop',
      locationId: city.id,
      coverageLevel: 'city',
      count: 12,
      prefix: 'stonecutter',
    })

    h.close()
    assert.equal(runMaintenance(h.dir).status, 0)
    assert.equal(runMaintenance(h.dir).status, 0)
    h.reopen()

    const runs = h.app.intelligence.recentRuns(10)
    assert.equal(runs.filter((row) => row.kind === 'gaps').length, 2, 'both runs are recorded')

    const matches = h.app.intelligence
      .opportunities({ state: 'candidate' })
      .items.filter((row) => row.keyword === 'granite worktop')
    assert.equal(matches.length, 1, 'the second run refreshed the opportunity instead of duplicating it')
  } finally {
    h.cleanup()
  }
})
