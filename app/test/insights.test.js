import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'
import { runGapEngine } from '../src/engine/gaps.js'
import { deriveOpportunity } from '../src/core/intelligence.js'
import { camelizeRow } from '../src/db/mapping.js'

/**
 * Two regressions on the same surface, both of which made the headline page of the
 * platform quietly wrong rather than loudly broken.
 *
 * THE FIRST: every opportunity was withheld, always
 *
 * `GET /api/v1/insights/opportunities` applies the k-anonymity floor to each row
 * it returns, reading `row.distinctActors`. The `opportunity` table had no
 * `distinct_actors` column, so the read was `undefined`, the `?? 0` fallback made
 * it zero, and `0 < 5` was true for every row. The endpoint returned an empty list
 * for every input, on every database, including one the engine had just filled with
 * twenty correct candidates.
 *
 * It survived 136 passing tests because nothing joined the engine to the route.
 * The engine tests asserted on `gap_snapshot`; the API tests asserted on envelopes
 * and error codes. The two halves each passed, and the seam between them was where
 * the rows disappeared. These tests run the engine and then read the endpoint, so
 * that seam is now covered.
 *
 * THE SECOND: every opportunity scored zero
 *
 * `deriveOpportunity` read `gap.score` from a camelised `gap_snapshot` row, whose
 * column is `gap_score`, and whose camelised field is therefore `gapScore`. The
 * expression was `undefined`, `recordOpportunities` coerced it with `?? 0`, and
 * every row was stored with a score of zero. The endpoint's default sort is
 * `score`, so the "ranked" opportunity list was in whatever order the database
 * happened to return.
 *
 * Neither of these would ever throw. That is the property worth testing: they are
 * bugs that produce a plausible-looking empty or arbitrarily-ordered response, and
 * only an assertion on the actual values catches them.
 */

const K = 5
const ACTORS = 12

/** A mounted server over a migrated, reference-seeded temp database. */
async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-insights-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'insights.db'),
    privacy: { kThreshold: K },
  })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  return {
    app,
    server,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function firstDistrict(app) {
  const { items } = app.locations.listByKind('district', {})
  assert.ok(items?.length, 'the reference dataset has a district')
  return items[0]
}

/**
 * A place with plenty of demand and no supply, which is the one case that reliably
 * produces a promotable opportunity.
 */
async function demandWithNoSupply(ctx, { phrase, actors = ACTORS }) {
  const district = firstDistrict(ctx.app)
  for (let i = 0; i < actors; i += 1) {
    ctx.app.demand.recordSearch({
      query: phrase,
      locationId: district.id,
      coverageLevel: 'district',
      totalResults: 0,
      actorSeed: `${phrase}-actor-${i}`,
    })
  }
  ctx.app.demand.rollupDay(new Date().toISOString().slice(0, 10))
  return district
}

test('the score survives the trip from the gap snapshot to the opportunity', async (t) => {
  // A pure unit test of the field name, because this is where the drift happened
  // and it is invisible in any assertion that does not read the number.
  const rawSnapshotRow = {
    phrase: 'granite worktop',
    searches: 31,
    distinct_actors: 28,
    supply_count: 0,
    gap_score: 0.87,
    severity: 'critical',
    average_result_quality: 'none_in_area',
  }
  const gap = camelizeRow(rawSnapshotRow)

  assert.equal(gap.score, undefined, 'the camelised field is not `score`')
  assert.equal(gap.gapScore, 0.87)

  const derived = deriveOpportunity({
    gap,
    trend: { direction: 'steady', ratio: 1, window: 14 },
    keyword: gap.phrase,
    locationName: 'Entebbe',
  })

  assert.equal(
    derived.score,
    0.87,
    'deriveOpportunity must read gapScore, or every opportunity is stored with a score of zero',
  )
})

test('an opportunity the engine wrote is actually returned by the endpoint', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  await demandWithNoSupply(ctx, { phrase: 'granite worktop' })
  const run = runGapEngine(ctx.app)
  assert.ok(run.opportunitiesWritten > 0, 'the engine produced opportunities')

  const response = await ctx.server.inject({ method: 'GET', url: '/api/v1/insights/opportunities' })
  assert.equal(response.statusCode, 200, response.body)

  const body = response.json()
  assert.equal(body.meta.total, run.opportunitiesWritten, 'none of them were withheld')
  assert.ok(body.data.length > 0, 'the endpoint returned an empty list for a populated database')
  assert.ok(
    body.data.some((row) => row.keyword === 'granite worktop'),
    'and the phrase we searched for is among them',
  )
})

test('a below-floor phrase never becomes an opportunity at all', async (t) => {
  // The regression test for the regression test. Fixing the missing column could
  // have been done by dropping the route's filter, and these two tests are what
  // stops that from being the fix that passes.
  //
  // The guarantee is enforced one layer earlier than the route, which is worth
  // being precise about: the engine only writes an opportunity for a gap that is
  // already unsuppressed, so there is no below-floor opportunity row for the
  // endpoint to withhold. The endpoint's own `includeSuppressed` therefore has
  // nothing extra to reveal here - which is the stronger outcome, not a weaker
  // test. The route's filter is still asserted directly, below, against a row
  // whose stored count is genuinely under the floor.
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  await demandWithNoSupply(ctx, { phrase: 'wheel alignment', actors: K - 1 })
  const run = runGapEngine(ctx.app)
  assert.ok(run.gapsSuppressed > 0, 'a sub-floor phrase is suppressed by the engine')

  const stored = ctx.app.db
    .prepare('SELECT COUNT(*) AS n FROM opportunity WHERE keyword = ?')
    .get('wheel alignment')
  assert.equal(stored.n, 0, 'so no opportunity row was written for it at all')

  const response = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?includeSuppressed=true',
  })
  assert.ok(
    !response.json().data.some((row) => row.keyword === 'wheel alignment'),
    'and it is not published, even asked for explicitly',
  )
})

test('a stored row under the floor is withheld by the route itself', async (t) => {
  // The route's own filter, exercised directly. Migration 011 backfills
  // `distinct_actors` from the parent snapshot, so a row whose count is under the
  // floor is reachable in the table but must not leave through the API.
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  await demandWithNoSupply(ctx, { phrase: 'granite worktop' })
  runGapEngine(ctx.app)

  // Force the row under the floor, standing in for a database that was migrated
  // from a snapshot later removed, or any future write that under-counts.
  ctx.app.db.prepare('UPDATE opportunity SET distinct_actors = ?').run(K - 1)

  const response = await ctx.server.inject({ method: 'GET', url: '/api/v1/insights/opportunities' })
  const rows = response.json().data
  assert.ok(
    !rows.some((row) => row.keyword === 'granite worktop'),
    'a row under the floor is not published',
  )

  const included = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?includeSuppressed=true',
  })
  const marked = included.json().data.find((row) => row.keyword === 'granite worktop')
  assert.ok(marked, 'it is returned when explicitly asked for')
  assert.equal(marked.suppressed, true, 'and flagged as suppressed')
  assert.equal(marked.distinctActors, null, 'and the count itself is withheld')
})

test('a returned opportunity carries the actor count it was judged on', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  await demandWithNoSupply(ctx, { phrase: 'granite worktop' })
  runGapEngine(ctx.app)

  const response = await ctx.server.inject({ method: 'GET', url: '/api/v1/insights/opportunities' })
  const [row] = response.json().data
  assert.ok(row, 'there is an opportunity to inspect')
  assert.equal(
    row.distinctActors,
    ACTORS,
    'the published count is the real one, not a default that happens to clear the floor',
  )
  assert.ok(row.distinctActors >= K, 'and it is genuinely above the floor')
})

test('sorting by score actually orders by score', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  // Two phrases with different volumes, so their scores differ. A sort over a
  // column that is uniformly zero returns them in arbitrary order and still
  // "passes" a length check.
  await demandWithNoSupply(ctx, { phrase: 'granite worktop', actors: 30 })
  await demandWithNoSupply(ctx, { phrase: 'sewing machine repair', actors: 8 })
  runGapEngine(ctx.app)

  const response = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?sort=score',
  })
  const rows = response.json().data
  assert.ok(rows.length >= 2, 'two opportunities to order')

  const scores = rows.map((row) => row.score)
  assert.ok(
    scores.some((score) => score > 0),
    `at least one score is non-zero, got ${JSON.stringify(scores)}`,
  )
  const descending = [...scores].sort((a, b) => b - a)
  assert.deepEqual(scores, descending, 'and the response is in descending score order')
})
