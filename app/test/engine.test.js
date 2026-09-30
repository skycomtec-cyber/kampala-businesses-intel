import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { computeGapScore } from '../src/core/intelligence.js'
import { runGapEngine } from '../src/engine/gaps.js'

/**
 * The gap engine's own tests.
 *
 * This engine was the missing half of the platform: demand was collected and
 * rolled up faithfully and the scoring rules were written and tested, but nothing
 * had ever called them together, so every table the insights pages read was
 * permanently empty. These tests exist so that "it ran" is a claim with evidence
 * behind it, and so that the privacy floor, the per-business supply count and the
 * opportunity upsert cannot quietly regress - each of those has a specific,
 * already-discovered failure it is guarding against.
 */

const K = 5
const WINDOW_DAYS = 30

function freshApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-engine-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'test.db'),
    privacy: { kThreshold: K },
    ...overrides,
  })
  const app = openApp({ config })
  return {
    app,
    cleanup() {
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Reference scaffolding: Uganda > Central > Wakiso > Kampala. */
function seedReference(app) {
  const country = app.locations.create({
    kind: 'country',
    name: 'Uganda',
    latitude: 1.3733,
    longitude: 32.5825,
  })
  const region = app.locations.create({
    kind: 'region',
    name: 'Central Region',
    parentId: country.id,
  })
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

/** A published, searchable business. Search is what supply is measured from. */
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
 * Records one search from a distinct actor.
 *
 * `at` matters: the rollup is by day, and the engine reads a window ending today,
 * so a search has to land inside that window to be measured at all.
 */
function search(app, { query, locationId, coverageLevel, totalResults, actorSeed, at, inAreaResults }) {
  return app.demand.recordSearch({
    query,
    locationId: locationId ?? null,
    coverageLevel: coverageLevel ?? 'country',
    totalResults,
    inAreaResults,
    actorSeed,
    at,
  })
}

/**
 * A day inside the engine's window: `offset` days back from today, so 0 is today.
 *
 * The engine reads a window ending *today*, and the tests below deliberately reach
 * back one and two days rather than placing everything on today, because a gap
 * engine that can only ever see a single day of demand is not being tested at all.
 *
 * This helper used to be `dayOffsetFromYesterday`, with 0 meaning yesterday, and
 * every call site was written to reach back past the end of the window. That is the
 * clearest single statement of the bug it was working around: the whole suite
 * avoided today because today was invisible, and so nothing ever failed when it
 * stayed that way.
 */
function daysAgo(offset) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - offset)
  date.setUTCHours(9, 0, 0, 0)
  return date
}

test('a run measures demand against supply and promotes opportunities', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    // Twelve people asked for a phrase that has no supply at all. Twelve, not five,
    // because five is the floor and scoring exactly at the floor is a boundary case
    // that should not be the only thing under test.
    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'turbine welding',
        locationId: city.id,
        coverageLevel: 'city',
        totalResults: 0,
        actorSeed: `welder-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const run = runGapEngine(app)

    assert.equal(run.status, 'completed')
    assert.equal(run.windowDays, WINDOW_DAYS)
    // A single search records every n-gram of the query, so "turbine welding"
    // measures three signals (the phrase and both single words), and searchesSeen
    // is the total across all of them. The platform measures a person saying more
    // than one thing as more than one thing; that is the intent, so the test reads
    // the signal it cares about rather than the total.
    assert.equal(run.gapsWritten, 3)
    assert.equal(run.gapsSuppressed, 0)
    assert.equal(run.searchesSeen, 36)

    const { items: gaps } = app.intelligence.gaps({ runId: run.id })
    const gap = gaps.find((row) => row.phrase === 'turbine welding')
    assert.ok(gap, 'the phrase people searched for should have been measured')
    assert.equal(gap.suppressed, false)
    assert.equal(gap.supplyCount, 0, 'nothing in the index serves this phrase')
    assert.equal(gap.supplyScore, 0)
    assert.equal(gap.searches, 12)
    assert.equal(gap.locationName, 'Kampala')
    assert.equal(gap.averageResultQuality, 'zero')
    assert.ok(gap.gapScore > 0, 'demand with no supply is a gap')
    assert.equal(gap.severity, 'critical')

    // The stored inputs are the ones that produced the score, so the number in the
    // lab can be recomputed instead of trusted.
    assert.equal(gap.inputs.demand.searches, 12)
    assert.equal(gap.inputs.supply.businessCount, 0)

    const { items: opportunities } = app.intelligence.opportunities()
    assert.equal(opportunities.length, 3, 'each of the three n-grams is its own finding')
    const opportunity = opportunities.find((row) => row.keyword === 'turbine welding')
    assert.equal(opportunity.severity, 'critical')
    assert.equal(opportunity.state, 'candidate')
    assert.equal(opportunity.gapSnapshotId, gap.id, 'an opportunity names the gap it came from')
    assert.match(opportunity.rationale, /turbine welding/)
    assert.match(opportunity.suggestedAction, /No provider exists/)
  } finally {
    cleanup()
  }
})

test('supply is counted per business, not per matching document', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    // One business whose name, three services and two products all match the same
    // phrase. A document count would report six units of supply here and close the
    // gap; there is exactly one business that can serve it.
    const business = publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Solar',
      description: 'Solar panel installation and maintenance.',
    })
    app.businesses.addService(business.id, {
      name: 'Solar panel repair',
      categoryId: category.id,
      description: 'Solar panel repair and servicing.',
    })
    app.businesses.addService(business.id, {
      name: 'Solar installation',
      categoryId: category.id,
      description: 'Rooftop solar installation.',
    })
    app.businesses.addService(business.id, {
      name: 'Solar maintenance',
      categoryId: category.id,
      description: 'Scheduled solar maintenance visits.',
    })
    app.businesses.addProduct(business.id, {
      name: 'Solar panel',
      categoryId: category.id,
      condition: 'new',
      quantity: 5,
    })
    app.businesses.addProduct(business.id, {
      name: 'Solar inverter',
      categoryId: category.id,
      condition: 'new',
      quantity: 3,
    })

    // Search finds all six documents...
    assert.equal(app.searchIndex.search({ query: 'solar' }).total, 6)
    // ...but the platform has one supplier of solar.
    const supply = app.searchIndex.supplyFor({ query: 'solar' })
    assert.equal(supply.documentCount, 6)
    assert.equal(supply.businessCount, 1)
    assert.equal(supply.bySource.business, 1)
    assert.equal(supply.bySource.service, 3)
    assert.equal(supply.bySource.product, 2)
    assert.equal(supply.verifiedCount, 1, 'the one business has been reviewed and published')

    // And the census agrees: one business, three services, two products.
    const totals = app.searchIndex.supplyTotals({})
    assert.equal(totals.businessCount, 1)
    assert.equal(totals.serviceCount, 3)
    assert.equal(totals.productCount, 2)
    assert.equal(totals.verifiedCount, 1)
  } finally {
    cleanup()
  }
})

test('a well supplied phrase does not become a gap', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    // Nine verified businesses offering the same service. demandAdequacy is full
    // supply weight / 5, so a handful of verified businesses is already ample.
    for (let index = 0; index < 9; index += 1) {
      publishBusiness(app, {
        city,
        category,
        name: `Kampala Cakes ${index}`,
        description: 'Fresh cakes and pastries baked daily in Kampala.',
      })
    }

    // Steady demand across the whole window rather than one day of it. A single
    // day reads as an emerging trend, and an emerging trend is allowed to lift a
    // score on its own - so twelve searches in one day against nine providers
    // lands at 0.23, not 0, which is the rule working rather than failing. To
    // test that supply alone settles it, the trend has to be flat.
    for (let offset = 0; offset < 15; offset += 1) {
      for (let index = 0; index < 12; index += 1) {
        search(app, {
          query: 'pastries',
          locationId: city.id,
          coverageLevel: 'city',
          totalResults: 9,
          actorSeed: `cake-${offset}-${index}`,
          at: daysAgo(offset + 1),
        })
      }
      app.demand.rollupDay(daysAgo(offset + 1).toISOString().slice(0, 10))
    }

    const run = runGapEngine(app)
    const { items: gaps } = app.intelligence.gaps({ runId: run.id })
    const gap = gaps.find((row) => row.phrase === 'pastries')

    assert.ok(gap, 'it is still measured, even when the answer is "no gap"')
    assert.equal(gap.supplyCount, 9)
    assert.equal(gap.trendDirection, 'flat', 'steady demand is not a trend')
    assert.equal(gap.severity, 'none', 'nine providers is not a gap')
    assert.equal(gap.gapScore, 0)
    assert.equal(run.opportunitiesWritten, 0, 'a satisfied need is not an opportunity')
  } finally {
    cleanup()
  }
})

test('a signal below the k-anonymity floor is stored defused and never promoted', () => {
  const { app, cleanup } = freshApp()
  try {
    for (let index = 0; index < 2; index += 1) {
      search(app, {
        query: 'hydrotherapy',
        totalResults: 0,
        actorSeed: `private-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const run = runGapEngine(app)

    assert.equal(run.gapsWritten, 1)
    assert.equal(run.gapsSuppressed, 1, 'the run counts what the floor is hiding')
    assert.equal(run.opportunitiesWritten, 0)

    // Suppression is applied at write time, not at read time, so the row is already
    // inert in any export or report that reaches for it directly.
    const stored = app.db
      .prepare('SELECT gap_score, severity, suppressed, k_threshold FROM gap_snapshot WHERE run_id = ?')
      .get(run.id)
    assert.equal(stored.gap_score, 0)
    assert.equal(stored.severity, 'none')
    assert.equal(stored.suppressed, 1)
    assert.equal(stored.k_threshold, K)

    // And the default reader hides it.
    assert.equal(app.intelligence.gaps({ runId: run.id }).total, 0)
    assert.equal(app.intelligence.gaps({ runId: run.id, includeSuppressed: true }).total, 1)
  } finally {
    cleanup()
  }
})

test('re-running refreshes a countrywide opportunity instead of duplicating it', () => {
  const { app, cleanup } = freshApp()
  try {
    // No location at all, which is the case the old UNIQUE (keyword, location_id)
    // constraint silently failed on: NULL is distinct from NULL in SQLite, so every
    // recompute used to append another copy of the same countrywide finding.
    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'hydroponics',
        coverageLevel: 'country',
        totalResults: 0,
        actorSeed: `grower-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const first = runGapEngine(app)
    const second = runGapEngine(app)

    assert.equal(first.opportunitiesWritten, 1)
    assert.equal(second.opportunitiesWritten, 1)

    const { items } = app.intelligence.opportunities()
    assert.equal(items.length, 1, 'the same finding twice is one finding')
    assert.equal(items[0].keyword, 'hydroponics')
    assert.equal(items[0].locationId, null)
    // A countrywide finding is labelled as one rather than left blank.
    assert.equal(items[0].locationName, 'Uganda')

    // The refresh points at the newer gap snapshot, so the opportunity is always
    // explicable against the run that most recently measured it.
    const current = app.intelligence.gap(items[0].gapSnapshotId)
    assert.equal(current.runId, second.id)
  } finally {
    cleanup()
  }
})

test('a rising phrase is annotated as rising and its opportunity says so', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)

    // A flat baseline for two weeks, then a spike. detectTrend needs two full
    // windows to compare, so the baseline has to be long enough to be a baseline.
    for (let offset = 20; offset >= 8; offset -= 1) {
      for (let actor = 0; actor < 5; actor += 1) {
        search(app, {
          query: 'plumbing',
          locationId: city.id,
          coverageLevel: 'city',
          totalResults: 0,
          actorSeed: `baseline-${offset}-${actor}`,
          at: daysAgo(offset + 1),
        })
      }
      app.demand.rollupDay(daysAgo(offset + 1).toISOString().slice(0, 10))
    }
    for (let offset = 0; offset < 7; offset += 1) {
      for (let actor = 0; actor < 30; actor += 1) {
        search(app, {
          query: 'plumbing',
          locationId: city.id,
          coverageLevel: 'city',
          totalResults: 0,
          actorSeed: `spike-${offset}-${actor}`,
          at: daysAgo(offset + 1),
        })
      }
      app.demand.rollupDay(daysAgo(offset + 1).toISOString().slice(0, 10))
    }

    const run = runGapEngine(app)
    const { items: gaps } = app.intelligence.gaps({ runId: run.id })
    const gap = gaps.find((row) => row.phrase === 'plumbing')

    assert.ok(gap)
    assert.equal(gap.trendDirection, 'rising')
    assert.ok(gap.trendRatio > 1.5, `expected a clear rise, got ${gap.trendRatio}`)
    assert.ok(gap.trendDelta > 0, 'a rising trend adds to the score')

    const opportunity = app.intelligence
      .opportunities()
      .items.find((row) => row.keyword === 'plumbing')
    assert.match(opportunity.rationale, /Demand is rising/)
  } finally {
    cleanup()
  }
})

test('a run records daily supply metrics and the public counters', () => {
  const { app, cleanup } = freshApp()
  try {
    const { district, city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa.',
    })

    // A second city, so the national census and the Kampala census are different
    // numbers. Without this every scope holds the same count and a test cannot
    // tell a real per-place measurement from the national one wearing a
    // different label.
    const other = app.locations.create({ kind: 'city', name: 'Entebbe', parentId: district.id })
    publishBusiness(app, {
      city: other,
      category,
      name: 'Entebbe Marine Repair',
      description: 'Boat engine servicing on the lake.',
    })

    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'sourdough',
        locationId: city.id,
        coverageLevel: 'city',
        totalResults: 0,
        actorSeed: `baker-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const run = runGapEngine(app)
    const today = daysAgo(0).toISOString().slice(0, 10)
    const supplyAt = (locationId) =>
      app.intelligence.supplySeries({
        locationId,
        categoryId: null,
        from: today,
        to: today,
      })

    // The scopes are the places the run actually measured: Kampala, because a gap
    // was found there, and the country, because that is the baseline a
    // location-less gap is measured against.
    const national = supplyAt(null)
    assert.equal(national.length, 1)
    assert.equal(national[0].coverageLevel, 'country')
    assert.equal(national[0].businessCount, 2, 'the country sees both businesses')
    assert.equal(national[0].verifiedCount, 2)

    const kampala = supplyAt(city.id)
    assert.equal(kampala.length, 1)
    assert.equal(kampala[0].coverageLevel, 'city')
    assert.equal(kampala[0].businessCount, 1, 'Kampala sees only its own')
    assert.equal(kampala[0].verifiedCount, 1)
    assert.equal(kampala[0].serviceCount, 0)
    assert.equal(kampala[0].productCount, 0)

    assert.equal(app.intelligence.stat('open_opportunities'), 1)
    assert.equal(app.intelligence.stat('gaps_total'), 1)
    assert.equal(app.intelligence.stat('gaps_critical'), 1)
    assert.equal(app.intelligence.stat('gaps_suppressed'), 0)

    // Re-running refreshes the same day rather than appending a second row for it.
    runGapEngine(app)
    assert.equal(supplyAt(null).length, 1)
    assert.equal(supplyAt(city.id).length, 1)
  } finally {
    cleanup()
  }
})

test('a scope the run stops measuring is dropped, not left holding a stale count', () => {
  const { app, cleanup } = freshApp()
  try {
    const { district, city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const other = app.locations.create({ kind: 'city', name: 'Jinja', parentId: district.id })
    publishBusiness(app, {
      city,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa.',
    })
    publishBusiness(app, {
      city: other,
      category,
      name: 'Jinja Marine Repair',
      description: 'Boat engine servicing on the lake.',
    })

    // Demand for the same phrase in both cities, yesterday, so a two-day window
    // ending today sees both and a one-day window ending today sees neither. The
    // placement is one day later than it used to be, and for the same reason: the
    // window moved forward a day, so the fixture had to move with it.
    for (const location of [city, other]) {
      for (let index = 0; index < 12; index += 1) {
        search(app, {
          query: 'sourdough',
          locationId: location.id,
          coverageLevel: 'city',
          totalResults: 0,
          actorSeed: `baker-${location.id}-${index}`,
          at: daysAgo(1),
        })
      }
    }
    app.demand.rollupDay(daysAgo(1).toISOString().slice(0, 10))

    // The window ends today, so a two-day window covers the demand and a one-day
    // window does not. Both runs write the same day of the series.
    runGapEngine(app, { windowDays: 2 })

    const today = daysAgo(0).toISOString().slice(0, 10)
    const supplyAt = (locationId) =>
      app.intelligence.supplySeries({ locationId, categoryId: null, from: today, to: today })
    assert.equal(supplyAt(city.id).length, 1, 'Kampala was measured')
    assert.equal(supplyAt(other.id).length, 1, 'Jinja was measured')

    runGapEngine(app, { windowDays: 1 })
    assert.equal(
      supplyAt(city.id).length,
      0,
      'Kampala is not in the narrower window, so it keeps no row claiming it was counted',
    )
    assert.equal(
      supplyAt(other.id).length,
      0,
      'and neither does Jinja, which is the same fact rather than a special case',
    )
    assert.equal(
      supplyAt(null).length,
      1,
      'the national baseline is always measured, so a location-less gap has something to compare against',
    )
  } finally {
    cleanup()
  }
})

test('a location-less gap does not produce two rows for the same national census', () => {
  const { app, cleanup } = freshApp()
  try {
    const { country } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    publishBusiness(app, {
      city: country,
      category,
      name: 'Nakawa Bakery',
      description: 'Bread and pastries baked in Nakawa.',
    })

    // Recorded with no location, so the gap's own scope is the whole country and
    // carries no level to name it. The national baseline must not then be added on
    // top: one census, one row.
    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'sourdough',
        locationId: null,
        coverageLevel: null,
        totalResults: 0,
        actorSeed: `baker-${index}`,
        at: daysAgo(1),
      })
    }
    app.demand.rollupDay(daysAgo(1).toISOString().slice(0, 10))
    runGapEngine(app)

    const today = daysAgo(0).toISOString().slice(0, 10)
    const national = app.intelligence.supplySeries({
      locationId: null,
      categoryId: null,
      from: today,
      to: today,
    })
    assert.equal(national.length, 1)
    assert.equal(national[0].businessCount, 1)
  } finally {
    cleanup()
  }
})

test('the opportunity floor keeps weak findings as gaps', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    // Three published providers. supplyWeight is 1.0 each, so supplyAdequacy is
    // 3.0/5 = 0.6, which leaves a real but small amount of unmet demand: the
    // demand curve for six searches is strong, and it is the supply that decides
    // whether this is a market or a rounding error. Without these businesses the
    // same six searches with nothing at all in the index scores 'high', which is
    // the correct answer to a different question.
    for (let index = 0; index < 3; index += 1) {
      publishBusiness(app, {
        city,
        category,
        name: `Nile Kayaks ${index}`,
        description: 'Guided kayaking on the Nile for beginners and groups.',
      })
    }

    for (let index = 0; index < 6; index += 1) {
      search(app, {
        query: 'kayaking',
        totalResults: 3,
        actorSeed: `kayak-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const permissive = runGapEngine(app, { opportunityFloor: 'low' })
    assert.equal(permissive.gapsWritten, 1)
    const measured = app.intelligence.gaps({ runId: permissive.id }).items[0]
    assert.equal(measured.supplyCount, 3, 'supply is what kept the score down')

    // The severity is whatever core/intelligence.js says it is for these inputs,
    // not a constant copied into the test. That is the design claim the whole
    // module rests on - a stored gap must be recomputable from its own row - so it
    // is asserted rather than assumed.
    const expected = computeGapScore({
      searches: measured.searches,
      supplyScore: measured.supplyScore,
      distinctActors: measured.distinctActors,
      specificity: measured.specificity,
      kThreshold: measured.kThreshold,
      trendDelta: measured.trendDelta,
    })
    assert.equal(measured.gapScore, expected.score)
    assert.equal(measured.severity, expected.severity)
    assert.notEqual(measured.severity, 'none', 'six searches with three providers is a finding')

    assert.equal(permissive.opportunitiesWritten, 1, 'asked for a low floor, gets low findings')

    const strict = runGapEngine(app, { opportunityFloor: 'high' })
    assert.equal(strict.gapsWritten, 1, 'the gap is still measured')
    assert.equal(strict.opportunitiesWritten, 0, 'but a low finding is not promoted to high')
  } finally {
    cleanup()
  }
})

test('a failed run is recorded as failed rather than left running', () => {
  const { app, cleanup } = freshApp()
  try {
    // There has to be demand, or there is nothing to measure and the supply query
    // is never reached. Without this the test would pass for the wrong reason.
    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'scaffolding',
        totalResults: 0,
        actorSeed: `scaffold-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    // Break the supply measurement the way a real fault would. The point of the
    // test is what the run ledger says afterwards, not what went wrong.
    const original = app.searchIndex.supplyFor
    app.searchIndex.supplyFor = () => {
      throw new Error('supply index unavailable')
    }

    assert.throws(() => runGapEngine(app), /supply index unavailable/)

    app.searchIndex.supplyFor = original

    const failed = app.db
      .prepare('SELECT status, error FROM intelligence_run ORDER BY started_at DESC LIMIT 1')
      .get()
    assert.equal(failed.status, 'failed', 'a failed run must not read as healthy or running')
    assert.match(failed.error, /supply index unavailable/)
    assert.equal(
      app.intelligence.latestRun('gaps'),
      null,
      'a failed run is not the latest good one',
    )
  } finally {
    cleanup()
  }
})

test('the window ends today and covers the configured span', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    for (let index = 0; index < 12; index += 1) {
      search(app, {
        query: 'granite',
        locationId: city.id,
        coverageLevel: 'city',
        totalResults: 0,
        actorSeed: `stone-${index}`,
        at: daysAgo(2),
      })
    }
    app.demand.rollupDay(daysAgo(2).toISOString().slice(0, 10))

    const run = runGapEngine(app)
    const start = new Date(`${run.windowStart}T00:00:00.000Z`)
    const end = new Date(`${run.windowEnd}T00:00:00.000Z`)
    const spanDays = Math.round((end - start) / 86400000) + 1

    assert.equal(spanDays, WINDOW_DAYS, 'a 30-day window spans 30 days inclusive')

    // This used to assert the opposite, and the assertion is the bug in one line:
    // the window ended yesterday "because today has not been rolled up yet", so the
    // engine could never see the newest demand it had just collected. The rollup
    // that matters runs before the engine in `maintenance.js`, so the newest day is
    // always available by the time a run measures it.
    const startOfToday = new Date(`${daysAgo(0).toISOString().slice(0, 10)}T00:00:00.000Z`)
    assert.equal(
      end.toISOString().slice(0, 10),
      startOfToday.toISOString().slice(0, 10),
      'the window ends today, so a run can measure the demand it just collected',
    )
    assert.equal(app.intelligence.gaps({ runId: run.id }).total, 1)
  } finally {
    cleanup()
  }
})

test('writeGaps returns the rows it stored, ids included', () => {
  const { app, cleanup } = freshApp()
  try {
    const run = app.intelligence.startRun({ kind: 'gaps', windowDays: 30 })
    const stored = app.intelligence.writeGaps(run.id, [
      {
        phrase: 'pneumatic drills',
        locationId: null,
        searches: 20,
        supplyCount: 0,
        supplyScore: 0,
        gapScore: 0.8,
        severity: 'critical',
        inputs: { demand: { searches: 20 } },
      },
    ])

    assert.equal(stored.length, 1)
    assert.equal(stored[0].phrase, 'pneumatic drills')
    // The opportunity needs this id to name the gap it came from, so it has to come
    // back from the write rather than being looked up by phrase afterwards.
    assert.equal(app.intelligence.gap(stored[0].id).gapScore, 0.8)

    const empty = app.intelligence.writeGaps(run.id, [])
    assert.deepEqual(empty, [], 'a run with nothing to measure is not an error')
  } finally {
    cleanup()
  }
})

test('a window names the most specific coverage level it spans, not the largest word', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const toDay = (offset) => daysAgo(offset + 1).toISOString().slice(0, 10)

    // A daily signal is one phrase at one location, and the rollup's bucket key
    // leaves coverage_level out on purpose - so within a day there is a single
    // label to carry. Across days in a window there is not, and the window has to
    // resolve it.
    //
    // The discriminator: alphabetically 'region' > 'district', so taking the
    // largest string reports the coarser of the two as the most specific. The
    // hierarchy in core/location.js has district below city, so the answer is
    // district.
    for (const [offset, coverageLevel] of [[1, 'region'], [0, 'district']]) {
      for (let index = 0; index < 6; index += 1) {
        search(app, {
          query: 'welding workshop',
          locationId: city.id,
          coverageLevel,
          totalResults: 0,
          actorSeed: `welder-${coverageLevel}-${index}`,
          at: daysAgo(offset + 1),
        })
      }
      app.demand.rollupDay(toDay(offset))
    }

    const [signal] = app.demand
      .windowSignals({ from: toDay(1), to: toDay(0), kThreshold: K })
      .filter((row) => row.phrase === 'welding workshop' && row.locationId === city.id)

    assert.ok(signal, 'the two days aggregate into one signal')
    assert.equal(signal.coverageLevel, 'district')
    assert.equal(signal.searches, 12)
  } finally {
    cleanup()
  }
})
