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
import { seedReferenceData } from '../src/seed/index.js'
import { demoCoverage, seedDemo } from '../src/seed/demo.js'
import { DEMO_DEMAND, OUTCOME_EXPECTATIONS } from '../src/seed/demo-data.js'
import { runGapEngine } from '../src/engine/gaps.js'

/**
 * The demonstration dataset, asserted as outcomes rather than as row counts.
 *
 * These tests exist because a demonstration is only worth anything if it
 * demonstrates. A dataset that seeds successfully and then shows a page where
 * every finding is `critical` and one place has thirty businesses while another
 * has none is not a demonstration, it is a fixture, and nothing in a clean run
 * would say so.
 *
 * The scores and severities asserted here were measured, not chosen. Where the
 * first draft of the dataset did not produce the spread it claimed, the fix went
 * into the dataset - more providers in Kampala, three in Mukono - rather than into
 * the scoring, because the scoring is the product's to decide and the dataset is
 * only supposed to make the decision visible. What the measurements exposed about
 * that scoring is written up at the bottom of this file and in the summary that
 * accompanies it; it is a finding, not a test failure.
 *
 * One database is built and shared, because building it is the expensive part and
 * because these assertions are about one coherent state rather than independent
 * facts. `before` is the right hook for that: it runs once, and a failure in it
 * fails the file rather than each test re-deriving the same database.
 */

const K = 5
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const SEED_DEMO = path.join(APP_ROOT, 'scripts', 'seed-demo.js')
const DAY_MS = 86400000

let state = null

test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-demo-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'demo.db'),
    privacy: { kThreshold: K },
  })
  const app = openApp({ config })
  try {
    const reference = seedReferenceData(app, { config })
    const seeded = seedDemo(app)
    rollupDemoWindow(app, new Date())
    const run = runGapEngine(app)

    const findings = app.db
      .prepare('SELECT * FROM gap_snapshot')
      .all()
      .map((row) => ({ ...row, location_name: locationNameOf(app, row.location_id) }))
    const opportunities = app.intelligence.opportunities({}).items
    const coverage = demoCoverage(app)

    state = { app, reference, seeded, run, findings, opportunities, coverage, dir }
  } catch (error) {
    app.close()
    throw error
  }
})

test.after(() => {
  state?.app.close()
  if (state?.dir) fs.rmSync(state.dir, { recursive: true, force: true })
})

function locationNameOf(app, locationId) {
  if (locationId === null || locationId === undefined) return null
  return app.locations.findById(locationId)?.name ?? null
}

/** Every day the dataset touches, today included, matching the script. */
function rollupDemoWindow(app, now) {
  const span = DEMO_DEMAND.reduce((widest, row) => Math.max(widest, row.days ?? 1), 1)
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS)
    app.demand.rollupDay(day.toISOString().slice(0, 10))
  }
}

/** The one finding for a phrase in a place, or undefined. */
function findingFor(phrase, place) {
  return state.findings.find((f) => f.phrase === phrase && f.location_name === place)
}

function isOpportunity(phrase, place) {
  return state.opportunities.some((o) => {
    const location = o.locationName ?? null
    return (o.keyword === phrase || o.phrase === phrase) && location === place
  })
}

test('the demonstration builds, and it is the size it claims to be', () => {
  assert.ok(state.reference.locations > 0, 'reference locations seeded')
  assert.ok(state.reference.skills > 0, 'reference skills seeded')
  assert.ok(state.seeded.businesses.length >= 30, 'a market, not a sample')
  assert.ok(state.seeded.phrases.length >= 10, 'enough demand to have a distribution')
})

test('an uncovered place produces an unsuppressed opportunity', () => {
  const spec = OUTCOME_EXPECTATIONS.uncoveredPlaceProducesOpportunity
  const row = findingFor(spec.phrase, spec.place)
  assert.ok(row, `${spec.phrase} in ${spec.place} produced a finding`)
  assert.equal(row.suppressed, 0, 'not withheld')
  assert.equal(row.supply_count, 0, 'and genuinely has no supply')
  assert.equal(Boolean(row.suppressed), spec.expectSuppressed)
  assert.equal(isOpportunity(spec.phrase, spec.place), spec.expectOpportunity)
})

test('a well-supplied phrase does not become an opportunity', () => {
  const spec = OUTCOME_EXPECTATIONS.servedPhraseIsNotAnOpportunity
  const row = findingFor(spec.phrase, spec.place)
  assert.ok(row, `${spec.phrase} in ${spec.place} produced a finding`)
  assert.equal(row.suppressed, 0, 'it is real demand, it is just met')
  assert.ok(
    row.supply_count >= 5,
    `served by ${row.supply_count} provider(s); fewer than five is still a gap under the current curve`,
  )
  assert.notEqual(row.severity, 'critical', 'thirty-four searches against six providers is not a crisis')
  assert.equal(isOpportunity(spec.phrase, spec.place), spec.expectOpportunity)
})

test('a phrase below the k-anonymity floor is stored and withheld', () => {
  const spec = OUTCOME_EXPECTATIONS.belowFloorIsSuppressed
  const row = findingFor(spec.phrase, spec.place)
  assert.ok(row, `${spec.phrase} in ${spec.place} produced a finding`)
  assert.ok(row.distinct_actors < K, `only ${row.distinct_actors} distinct actor(s)`)
  assert.equal(row.suppressed, 1, 'withheld')
  assert.equal(row.severity, 'none', 'and carries no severity')
  assert.equal(Boolean(row.suppressed), spec.expectSuppressed)
  assert.equal(isOpportunity(spec.phrase, spec.place), false, 'a withheld finding is not promoted')
})

test('the dataset spans the severity range instead of declaring everything a crisis', () => {
  const bySeverity = new Map()
  for (const row of state.findings) {
    bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1)
  }
  const present = [...bySeverity.keys()].sort()

  // This is the assertion that would have caught the first draft, whose findings
  // were twenty of `critical` and eight withheld and nothing in between.
  assert.ok(bySeverity.get('critical') > 0, 'some things are genuinely critical')
  assert.ok(bySeverity.get('low') > 0, 'and some things are demonstrably fine')
  assert.ok(bySeverity.get('none') > 0, 'and some things are withheld entirely')
  assert.ok(
    present.length >= 3,
    `expected at least three distinct severities, got ${JSON.stringify(bySeverity)}`,
  )
})

test('middling supply lands between the extremes', () => {
  const spec = OUTCOME_EXPECTATIONS.middlingSupplyIsNotCritical
  const row = findingFor(spec.phrase, spec.place)
  assert.ok(row, `${spec.phrase} in ${spec.place} produced a finding`)
  assert.equal(row.severity, spec.expectSeverity)
  assert.notEqual(row.severity, 'critical', 'three providers is not zero providers')
  assert.equal(isOpportunity(spec.phrase, spec.place), spec.expectOpportunity)
})

test('coverage is uneven between districts', () => {
  const spec = OUTCOME_EXPECTATIONS.coverageIsUneven
  const thin = state.coverage[placeKey(spec.thin)]
  const thick = state.coverage[placeKey(spec.thick)]
  assert.ok(thin !== undefined, `coverage reported for ${spec.thin}`)
  assert.ok(thick !== undefined, `coverage reported for ${spec.thick}`)
  assert.equal(thin, 0, `${spec.thin} is deliberately empty`)
  assert.ok(thick >= 20, `${spec.thick} is crowded: ${thick}`)
  assert.ok(thick > thin * 10, 'and one number cannot describe both')
})

test('a rising phrase exists for the trend annotation to annotate', () => {
  const spec = OUTCOME_EXPECTATIONS.risingDemandIsPresent
  const row = findingFor(spec.phrase, spec.place)
  assert.ok(row, `${spec.phrase} in ${spec.place} produced a finding`)
  assert.ok(
    row.trend_delta > 0,
    `expected a rising trend, got delta ${row.trend_delta}`,
  )
  assert.equal(row.trend_delta > 0, spec.expectTrendUp)
})

/** The keys `demoCoverage` reports under, which are not the location names. */
function placeKey(place) {
  return place.toLowerCase().replace(/\s+/g, '')
}

/*
 * WHAT THE MEASUREMENTS EXPOSED ABOUT THE SCORING
 *
 * Recorded here rather than fixed, because it is a product decision and the dataset
 * should not make it silently. The numbers below are real and reproducible by
 * building the demonstration and reading `gap_snapshot`:
 *
 *   1. `demandWeight` saturates at ten searches. `ln(1+n)/ln(11)` reaches 1.0 at
 *      n=10, so a phrase searched ten times and a phrase searched four hundred
 *      times are equally loud, and the ceiling is below the smallest interesting
 *      market in the dataset.
 *
 *   2. `supplyAdequacy` divides by 5, and an approved business carries a trust
 *      weight of exactly 1, so "adequately supplied" means five matching approved
 *      businesses. On a young platform that is a high bar, and it is the reason the
 *      first draft of this dataset reported a city with two phone repair shops as a
 *      critical shortage.
 *
 *   3. Together those two make the score almost binary. Measured, for a phrase with
 *      saturated demand: 0 providers scores 1.0, 1 scores 0.93, 2 scores 0.76, 3
 *      scores 0.54, 5 scores about 0.05. Everything from 0 to 4 providers is
 *      `critical` or `high`, and there is no discount at all for partial coverage.
 *
 *   4. The consequence is that the public opportunity list is nearly all
 *      `critical`, which is the §1.3 problem showing up as a fact rather than as
 *      an argument. Whether the fix is a softer supply curve, a per-provider
 *      saturation point, or a ban on `critical` below some volume is a question for
 *      the product, not for a seed script.
 *
 *   5. Separately, the rollup files a phrase under its first token as well, so
 *      "mobile phone repair" also produces findings for "mobile" and "phone", and
 *      the opportunity list is populated with bare tokens like "services", "repair"
 *      and "worktop". No operator can act on a gap called "services". The
 *      `ngram_size` column is what distinguishes them, and nothing currently
 *      filters on it.
 */
