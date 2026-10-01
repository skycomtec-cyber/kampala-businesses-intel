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

test('sorting by demand orders by demand, and not by the default in disguise', async (t) => {
  // The route has always advertised `sort=demand` in its querystring schema, and
  // `resolveOrder` answers a key it does not know with the default rather than an
  // error. So the request always succeeded, always came back ordered by score, and
  // nothing about the response said otherwise. A reader who asked for the most
  // searched phrases first was shown a ranking, and it was not the one they asked
  // for.
  //
  // The rows are written directly rather than produced by the engine, because the
  // engine cannot make the two orders differ on its own: two phrases with no supply
  // at all both score 1, so a demand-ordered and a score-ordered response are the
  // same two rows in whichever order the tie-break picks. Pinning the ids makes the
  // tie-break deterministic - the repository appends `o.id ASC`, so an unsorted
  // fallback returns the low-id row first - and pinning the score to the same value
  // on both rows means the assertion below can only pass if the demand column is
  // really in the ORDER BY.
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const now = new Date().toISOString()
  const write = ctx.app.db.prepare(
    `INSERT INTO opportunity (
       id, keyword, severity, score, distinct_actors, estimated_monthly_searches,
       supply_count, trend_direction, rationale, state, created_at, updated_at
     ) VALUES (@id, @keyword, 'critical', 1, 30, @demand, 0, 'emerging', 'hand written', 'candidate', @now, @now)`,
  )
  write.run({
    // The low id, and the low demand. Ascending id puts this row first, so this is
    // the row a falling back to the default sort would have led with.
    id: '00000000-0000-4000-8000-000000000001',
    keyword: 'sewing machine repair',
    demand: 8,
    now,
  })
  write.run({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    keyword: 'granite worktop',
    demand: 31,
    now,
  })

  const response = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?sort=demand',
  })
  assert.equal(response.statusCode, 200, response.body)
  const rows = response.json().data
  assert.deepEqual(
    rows.map((row) => row.keyword),
    ['granite worktop', 'sewing machine repair'],
    'the most searched phrase comes first, whichever side of the tie-break it falls on',
  )
  const demand = rows.map((row) => row.estimatedMonthlySearches)
  assert.deepEqual(demand, [...demand].sort((a, b) => b - a), 'and the projection descends with it')
})

test('every sort the page offers is a sort the endpoint performs', async (t) => {
  // The general form of the two failures above, asserted once so a fourth cannot
  // arrive the same way. `sort` is an enum on the route and a key on the
  // repository's allowlist, and nothing connected the two: a key the allowlist
  // does not have passes validation and then falls back to the default order, so
  // the response is a successful ranking in the one order nobody asked for.
  //
  // The Gaps page's dropdown is the reason this matters. It was written against
  // `recent`, which the repository has never heard of - that key is `newest` - so
  // "Newest first" was ordered by score. This test reads the enum the route
  // publishes and the page's own `<option>` values, and asks for each one against a
  // table where the four orders disagree, so an option that is decorative fails
  // here rather than in a reader's face.
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  // Four rows, ordered differently by each of the four published orders, and with
  // the scores descending as the ids ascend so the default sort and the id
  // tie-break both lead with `granite worktop` - the row every wrong order has to
  // disagree with.
  const now = new Date().toISOString()
  const write = ctx.app.db.prepare(
    `INSERT INTO opportunity (
       id, keyword, severity, score, distinct_actors, estimated_monthly_searches,
       supply_count, trend_direction, rationale, state, created_at, updated_at
     ) VALUES (@id, @keyword, @severity, @score, 30, @demand, 0, 'emerging', 'hand written', 'candidate', @created, @now)`,
  )
  const day = 24 * 60 * 60 * 1000
  const start = Date.parse('2026-03-01T00:00:00.000Z')
  const rows = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      keyword: 'granite worktop',
      severity: 'low',
      score: 0.9,
      demand: 10,
      created: new Date(start).toISOString(),
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      keyword: 'sewing machine repair',
      severity: 'moderate',
      score: 0.8,
      demand: 20,
      created: new Date(start + day).toISOString(),
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      keyword: 'wheel alignment',
      severity: 'high',
      score: 0.7,
      demand: 30,
      created: new Date(start + 2 * day).toISOString(),
    },
    {
      id: '00000000-0000-4000-8000-000000000004',
      keyword: 'mobile money training',
      severity: 'critical',
      score: 0.6,
      demand: 40,
      created: new Date(start + 3 * day).toISOString(),
    },
  ]
  rows.forEach((row) => write.run({ ...row, now }))

  const keywords = async (url) => {
    const response = await ctx.server.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 200, response.body)
    return response.json().data.map((row) => row.keyword)
  }

  // What each published order has to produce. Score and id descend together on this
  // table, so `score` and `newest` differ only by the claim date - which is the
  // point: they must still be told apart by the dates, and they would collapse into
  // one order if the `newest` key were missing and both fell back to `score`.
  const orders = {
    score: ['granite worktop', 'sewing machine repair', 'wheel alignment', 'mobile money training'],
    newest: ['mobile money training', 'wheel alignment', 'sewing machine repair', 'granite worktop'],
    demand: ['mobile money training', 'wheel alignment', 'sewing machine repair', 'granite worktop'],
    severity: ['mobile money training', 'wheel alignment', 'sewing machine repair', 'granite worktop'],
  }

  // The orders that must not be one order. `newest` and `score` are the pair the
  // `recent` bug collapsed, so they are asserted separately even where the table
  // makes `demand` and `severity` agree with `newest`.
  const distinct = [...new Set(Object.values(orders).map((order) => order.join('|')))]

  for (const [sort, expected] of Object.entries(orders)) {
    assert.deepEqual(
      await keywords(`/api/v1/insights/opportunities?sort=${sort}`),
      expected,
      `sort=${sort} is the order it advertises`,
    )
  }
  assert.equal(distinct.length, 2, 'the table separates score from the other three')

  // The two vocabularies that have to agree, read from the files themselves rather
  // than restated, because restating them is what let them drift.
  const route = fs.readFileSync(
    new URL('../src/api/routes/insights.js', import.meta.url),
    'utf8',
  )
  const enumMatch = /sort: \{ type: 'string', enum: \[([^\]]+)\] \}/.exec(route)
  assert.ok(enumMatch, 'the route still publishes a sort enum')
  const advertised = [...enumMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])

  const repository = fs.readFileSync(
    new URL('../src/db/repositories/intelligence.js', import.meta.url),
    'utf8',
  )
  const allowlist = /const OPPORTUNITY_SORTS = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(
    repository,
  )
  assert.ok(allowlist, 'the repository still declares OPPORTUNITY_SORTS')
  const known = [...allowlist[1].matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1])

  assert.deepEqual(
    advertised.filter((key) => !known.includes(key)),
    [],
    'every advertised order is one the repository can perform, and the gap is what silently sorted by score',
  )

  // And the page's own order dropdown, which is where a reader picks the order from.
  // Scoped to that one `<select>`: the page has three others, whose values are window
  // lengths, places and severities, and none of those are sorts.
  const page = fs.readFileSync(new URL('../web/insights.html', import.meta.url), 'utf8')
  const orderSelect = /<select id="sort">([\s\S]*?)<\/select>/.exec(page)
  assert.ok(orderSelect, 'the page still has an order dropdown')
  const offered = [...orderSelect[1].matchAll(/<option value="([^"]*)"/g)].map(
    (match) => match[1],
  )
  assert.ok(offered.length > 1, 'and it still offers more than the one order it defaults to')
  assert.deepEqual(
    offered.filter((value) => !advertised.includes(value)),
    [],
    'and every order the page offers is one the endpoint advertises',
  )
})

test('the floor is applied before paging, so the total is the real one', async (t) => {
  // The third failure on this surface, and the only one that makes the endpoint
  // unusable rather than merely wrong.
  //
  // The route filtered the floor out of the page after the query had already run and
  // then reported the length of what survived as `meta.total`. The consequence is not
  // a wrong number on a good response, it is a page that cannot be walked: page two
  // says `total: 12` again, `hasMore` is false, and a client that trusts the offset
  // and asks anyway gets the same rows a second time - because the query skipped
  // `offset` rows before the floor took any of them out.
  //
  // The scores below are distinct on every row, including the below-floor ones, and
  // the below-floor rows carry the *highest* scores in the table. So if the predicate
  // is missing from the query, the first page is led by a row that must not be
  // published, the total is 8 rather than 5, and the assertions below fail on the
  // first page rather than somewhere in the third.
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const now = new Date().toISOString()
  const write = ctx.app.db.prepare(
    `INSERT INTO opportunity (
       id, keyword, severity, score, distinct_actors, estimated_monthly_searches,
       supply_count, trend_direction, rationale, state, created_at, updated_at
     ) VALUES (@id, @keyword, 'critical', @score, @actors, 30, 0, 'emerging', 'hand written', 'candidate', @now, @now)`,
  )
  const rows = [
    // Above the floor, descending by score, so the expected order is unambiguous.
    { keyword: 'granite worktop', score: 0.9, actors: 30 },
    { keyword: 'sewing machine repair', score: 0.8, actors: 30 },
    { keyword: 'wheel alignment', score: 0.7, actors: 30 },
    { keyword: 'mobile money training', score: 0.6, actors: 30 },
    { keyword: 'bicycle repair', score: 0.5, actors: 30 },
    // Below the floor, and deliberately scoring higher than everything published:
    // these are the rows that must not reach the first page.
    { keyword: 'under floor one', score: 0.95, actors: K - 1 },
    { keyword: 'under floor two', score: 0.85, actors: K - 2 },
    { keyword: 'under floor three', score: 0.75, actors: 1 },
  ]
  rows.forEach((row, index) => {
    write.run({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ...row,
      now,
    })
  })

  const page = async (offset) => {
    const response = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/insights/opportunities?limit=2&offset=${offset}&sort=score`,
    })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }

  const first = await page(0)
  assert.equal(first.meta.total, 5, 'the total counts the rows that match, not the page that arrived')
  assert.equal(first.meta.hasMore, true, 'and it admits there is a second page')
  assert.equal(first.meta.count, first.data.length, 'the page says how many rows it is holding')
  assert.deepEqual(
    first.data.map((row) => row.keyword),
    ['granite worktop', 'sewing machine repair'],
    'the page is led by the two highest publishable scores',
  )

  const walked = [...first.data]
  for (const offset of [2, 4]) {
    const body = await page(offset)
    assert.equal(body.meta.total, 5, 'the total does not change from page to page')
    walked.push(...body.data)
  }

  const last = await page(4)
  assert.equal(last.meta.hasMore, false, 'the last page admits it is the last one')
  assert.equal(last.data.length, 1, 'and is short rather than padded with a withheld row')

  assert.deepEqual(
    walked.map((row) => row.keyword),
    ['granite worktop', 'sewing machine repair', 'wheel alignment', 'mobile money training', 'bicycle repair'],
    'walking the pages yields every publishable finding once, in order, and nothing else',
  )
  assert.equal(new Set(walked.map((row) => row.id)).size, walked.length, 'with no row served twice')

  const all = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?limit=100&includeSuppressed=true',
  })
  assert.equal(
    all.json().meta.total,
    8,
    'and the withheld rows are still there when they are asked for by name',
  )
})
