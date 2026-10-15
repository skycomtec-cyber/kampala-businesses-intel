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
import { OPPORTUNITY_STATES } from '../src/core/intelligence.js'

/**
 * The laboratory.
 *
 * The public insights routes are built around one promise: a finding computed
 * over fewer people than the privacy floor allows is withheld. The laboratory is
 * the one surface allowed past that floor, and its whole reason to exist is the
 * asymmetry - seeing how much signal the promise is holding back. So these tests
 * are mostly about that asymmetry, and about the one write the lab offers.
 *
 * The floor is a property that only shows up when two layers are read together:
 * the engine writes a suppressed gap, the public route refuses it, and the lab
 * route returns it. Any one of those passing alone proves nothing, which is why
 * these run the engine and then read both endpoints against the same database.
 *
 * The write is the other half. Dismissing an opportunity is the only thing the
 * lab can change, it requires a reason, and it is permanent enough to be worth an
 * audit row. All three are asserted against the database rather than the response.
 */

const PASSWORD = 'Kampala-Reference-2026'
const K = 5
const ACTORS = 12
/** A syntactically valid id that matches no row, for the authorisation checks. */
const ABSENT_ID = '00000000-0000-4000-8000-0000000000ff'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-lab-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'lab.db'),
    privacy: { kThreshold: K },
  })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  return {
    app,
    server,
    config,
    dir,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function signIn(ctx, { email, role = 'admin' }) {
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Lab Operator', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

function firstDistrict(app) {
  const { items } = app.locations.listByKind('district', {})
  assert.ok(items?.length, 'the reference dataset has a district')
  return items[0]
}

/** Records `actors` distinct searches for one phrase in one district, then rolls up. */
function demandFor(ctx, phrase, actors) {
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

/**
 * One run over two phrases: one with plenty of demand and no supply (which the
 * engine promotes to an opportunity), and one under the floor (which it suppresses).
 */
function seedRun(ctx) {
  demandFor(ctx, 'granite worktop', ACTORS)
  demandFor(ctx, 'wheel alignment', K - 1)
  const run = runGapEngine(ctx.app)
  assert.ok(run.opportunitiesWritten > 0, 'the engine promoted at least one opportunity')
  assert.ok(run.gapsSuppressed > 0, 'and suppressed at least one gap')
  return run
}

/** The one opportunity the engine wrote for `granite worktop`. */
async function anOpportunity(ctx, headers) {
  const response = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/opportunities?includeSuppressed=true&includeDismissed=true',
    headers,
  })
  assert.equal(response.statusCode, 200, response.body)
  const row = response.json().data.find((item) => item.keyword === 'granite worktop')
  assert.ok(row, 'the opportunity the engine wrote is on the board')
  return row
}

/* --- who may read the laboratory --------------------------------------------- */

test('the laboratory is behind lab:read, and the board behind a write capability', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const anonymous = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/lab/overview' })
  assert.equal(anonymous.statusCode, 401, anonymous.body)

  // A viewer can read the directory and nothing else. The lab is closed to them.
  const viewer = await signIn(ctx, { email: 'viewer@kip.test', role: 'viewer' })
  const refused = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/overview',
    headers: viewer,
  })
  assert.equal(refused.statusCode, 403, refused.body)

  // An analyst may read the lab but not move an opportunity.
  const analyst = await signIn(ctx, { email: 'analyst@kip.test', role: 'analyst' })
  const readable = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/overview',
    headers: analyst,
  })
  assert.equal(readable.statusCode, 200, readable.body)

  const patch = (headers, id = ABSENT_ID) =>
    ctx.server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/lab/opportunities/${id}`,
      headers,
      payload: { state: 'validating' },
    })

  const analystWrite = await patch(analyst)
  assert.equal(analystWrite.statusCode, 403, analystWrite.body)

  // An editor carries opportunity:read but not opportunity:write, so the board
  // reads and the state change is refused. The two capabilities are separate on
  // purpose, and this is the role that tells them apart.
  const editor = await signIn(ctx, { email: 'editor@kip.test', role: 'editor' })
  assert.equal((await patch(editor)).statusCode, 403)

  // An admin gets past the gate, and is refused only because no such row exists.
  const admin = await signIn(ctx, { email: 'admin@kip.test', role: 'admin' })
  assert.equal((await patch(admin)).statusCode, 404)
})

/* --- the floor, lifted here and only here ------------------------------------ */

test('a suppressed finding is withheld publicly and returned by the laboratory', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  const admin = await signIn(ctx, { email: 'admin@kip.test' })
  const run = seedRun(ctx)

  // The public gaps list never shows the sub-floor phrase, even asked explicitly:
  // the engine writes no opportunity for a suppressed gap, so there is nothing to
  // reveal. This is the promise the lab refuses to keep.
  const publicList = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities?includeSuppressed=true',
  })
  assert.ok(
    !publicList.json().data.some((row) => row.keyword === 'wheel alignment'),
    'the public route withholds the sub-floor phrase',
  )

  // The overview counts both sides in one request, and that difference is the
  // number this page exists to show.
  const overview = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/overview',
    headers: admin,
  })
  assert.equal(overview.statusCode, 200, overview.body)
  const data = overview.json().data
  assert.equal(data.gaps.visible, run.gapsWritten - run.gapsSuppressed)
  assert.equal(data.gaps.suppressed, run.gapsSuppressed)
  assert.ok(data.gaps.suppressed >= 1, 'there is withheld signal to count')
  assert.equal(data.run.id, run.id, 'the overview reports the run that just finished')
  assert.ok(data.runs.some((row) => row.id === run.id), 'and the run is in the history')

  // The lab's gap list defaults to including suppressed rows, because an operator
  // asks "what did the engine find" rather than "what may be published".
  const filled = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/gaps',
    headers: admin,
  })
  assert.equal(filled.statusCode, 200, filled.body)
  const withheld = filled.json().data.find((row) => row.phrase === 'wheel alignment')
  assert.ok(withheld, 'the suppressed gap is in the list the lab serves by default')
  assert.equal(withheld.suppressed, true)
  assert.equal(withheld.gapScore, 0, 'and it travels already defused')

  // Asked for the publishable subset, it disappears - so the difference between
  // the two requests is exactly the floor.
  const publishable = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/gaps?includeSuppressed=false',
    headers: admin,
  })
  assert.ok(
    !publishable.json().data.some((row) => row.phrase === 'wheel alignment'),
    'and it is gone when only publishable rows are asked for',
  )
})

test('a below-floor opportunity the public never sees is on the lab board', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  const admin = await signIn(ctx, { email: 'admin@kip.test' })
  seedRun(ctx)

  // The engine only promotes an unsuppressed gap, so a below-floor opportunity is
  // reached by forcing the stored count down - standing in for a row migrated from
  // a snapshot later removed, or any future write that under-counts.
  ctx.app.db.prepare('UPDATE opportunity SET distinct_actors = ?').run(K - 1)

  const publicList = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities',
  })
  assert.ok(
    !publicList.json().data.some((row) => row.keyword === 'granite worktop'),
    'the public board withholds every row under the floor',
  )

  // The lab asks the same repository with no floor at all, so the row is present.
  const board = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/opportunities?includeSuppressed=true',
    headers: admin,
  })
  assert.equal(board.statusCode, 200, board.body)
  const row = board.json().data.find((item) => item.keyword === 'granite worktop')
  assert.ok(row, 'and the laboratory returns it')
  assert.equal(row.distinctActors, K - 1, 'with the real count the public may not see')
})

test('the demand signals keep their counts in the laboratory', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  const admin = await signIn(ctx, { email: 'admin@kip.test' })
  seedRun(ctx)

  const district = firstDistrict(ctx.app)
  const today = new Date().toISOString().slice(0, 10)
  const signals = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/admin/lab/signals?from=${today}&locationId=${district.id}&includeSuppressed=true`,
    headers: admin,
  })
  assert.equal(signals.statusCode, 200, signals.body)
  const rows = signals.json().data
  assert.ok(rows.length > 0, 'the window has signals')

  // The sub-floor phrase keeps its real count here, where the public route nulls it.
  const small = rows.find((row) => row.phrase === 'wheel alignment')
  assert.ok(small, 'the sub-floor phrase is among the signals')
  assert.equal(small.searches, K - 1, 'and its count is the real one, not a bucket label')
  assert.equal(small.suppressed, true, 'while still being flagged as under the floor')
})

/* --- the one write ----------------------------------------------------------- */

test('dismissing an opportunity requires a reason, and the change is audited', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  const admin = await signIn(ctx, { email: 'admin@kip.test' })
  seedRun(ctx)
  const opportunity = await anOpportunity(ctx, admin)

  const refused = await ctx.server.inject({
    method: 'PATCH',
    url: `/api/v1/admin/lab/opportunities/${opportunity.id}`,
    headers: admin,
    payload: { state: 'dismissed' },
  })
  assert.equal(refused.statusCode, 400, refused.body)
  assert.match(refused.json().error.message, /reason/i)
  // Nothing was written while the row was refused.
  assert.equal(ctx.app.audit.forEntity('opportunity', opportunity.id).length, 0)

  const reason = 'Closed: the demand came from a single event, not a market.'
  const dismissed = await ctx.server.inject({
    method: 'PATCH',
    url: `/api/v1/admin/lab/opportunities/${opportunity.id}`,
    headers: admin,
    payload: { state: 'dismissed', reason },
  })
  assert.equal(dismissed.statusCode, 200, dismissed.body)
  assert.equal(dismissed.json().data.state, 'dismissed')
  assert.equal(dismissed.json().data.stateReason, reason)

  // The audit row is the point: who moved it, and why.
  const audit = ctx.app.audit.forEntity('opportunity', opportunity.id)
  assert.equal(audit.length, 1, 'the state change left exactly one audit row')
  assert.equal(audit[0].action, 'intelligence.opportunity.state')
  assert.equal(audit[0].reason, reason)
  assert.equal(audit[0].actorRole, 'admin')

  // The board is the operator's working set, so a dismissed row stays on it by
  // default - the operator needs to see that a decision was taken and what the
  // reason was. It is hidden only when dismissals are explicitly excluded, and it
  // never reaches the public list.
  const board = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/opportunities?includeSuppressed=true',
    headers: admin,
  })
  const stillThere = board.json().data.find((row) => row.id === opportunity.id)
  assert.ok(stillThere, 'a dismissed opportunity stays on the operator board')
  assert.equal(stillThere.state, 'dismissed')

  const hidden = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/lab/opportunities?includeDismissed=false&includeSuppressed=true',
    headers: admin,
  })
  assert.ok(
    !hidden.json().data.some((row) => row.id === opportunity.id),
    'and leaves only when dismissals are excluded',
  )

  const publicList = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/insights/opportunities',
  })
  assert.ok(
    !publicList.json().data.some((row) => row.keyword === 'granite worktop'),
    'and the public never sees a dismissed opportunity',
  )

  // Any other transition is allowed without a reason.
  const reopened = await ctx.server.inject({
    method: 'PATCH',
    url: `/api/v1/admin/lab/opportunities/${opportunity.id}`,
    headers: admin,
    payload: { state: 'validating' },
  })
  assert.equal(reopened.statusCode, 200, reopened.body)
  assert.equal(reopened.json().data.state, 'validating')
})

/* --- validation -------------------------------------------------------------- */

test('the laboratory refuses a query it cannot answer', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  const admin = await signIn(ctx, { email: 'admin@kip.test' })

  const cases = [
    '/api/v1/admin/lab/gaps?sort=sideways',
    '/api/v1/admin/lab/gaps?severity=apocalyptic',
    '/api/v1/admin/lab/gaps?limit=0',
    '/api/v1/admin/lab/opportunities?state=unheard_of',
    '/api/v1/admin/lab/opportunities?sort=sideways',
    // `from` is required, because a demand window with no start is not a window.
    '/api/v1/admin/lab/signals',
    '/api/v1/admin/lab/supply?from=2026-01-01',
  ]
  for (const url of cases) {
    const response = await ctx.server.inject({ method: 'GET', url, headers: admin })
    assert.equal(response.statusCode, 400, `${url} should be refused, got ${response.statusCode}`)
  }
})

/* --- the page ----------------------------------------------------------------- */

test('the lab page offers only the sorts and states the api performs', () => {
  // The same protection the gaps page has, applied to the lab: a dropdown option
  // that is not a key the repository knows silently falls back to the default
  // order, so a reader is shown a ranking they did not ask for. Read from the
  // files rather than restated, because restating is what let the two drift.
  const route = fs.readFileSync(
    new URL('../src/api/routes/admin/lab.js', import.meta.url),
    'utf8',
  )
  const routeSorts = /const GAP_SORTS = \[([^\]]+)\]/.exec(route)
  assert.ok(routeSorts, 'the route still declares its gap sorts')
  const sorts = [...routeSorts[1].matchAll(/'([^']+)'/g)].map((match) => match[1])

  const page = fs.readFileSync(new URL('../web/lab.html', import.meta.url), 'utf8')
  const orderSelect = /<select id="gap-sort">([\s\S]*?)<\/select>/.exec(page)
  assert.ok(orderSelect, 'the page still has an order dropdown')
  const offered = [...orderSelect[1].matchAll(/<option value="([^"]*)"/g)].map(
    (match) => match[1],
  )
  assert.ok(offered.length > 1, 'and it offers more than the one order it defaults to')
  assert.deepEqual(
    offered.filter((value) => !sorts.includes(value)),
    [],
    'every order the page offers is one the endpoint performs',
  )

  // The board's own state list, which is what a write actually sends.
  const statesOnPage = /const states = \[([^\]]+)\]/.exec(page)
  assert.ok(statesOnPage, 'the page still declares the states the board can set')
  const states = [...statesOnPage[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    [...states].sort(),
    [...OPPORTUNITY_STATES].sort(),
    'the board can move an opportunity into exactly the states the engine defines',
  )
})

test('every page offers a way into the laboratory', () => {
  const webDir = new URL('../web/', import.meta.url)
  const pages = fs.readdirSync(webDir).filter((name) => name.endsWith('.html'))
  assert.ok(pages.length > 10, 'there is more than a handful of pages to check')
  for (const name of pages) {
    const html = fs.readFileSync(new URL(name, webDir), 'utf8')
    assert.match(html, /href="\/lab\.html"/, `${name} links to the laboratory`)
  }
})
