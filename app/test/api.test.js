import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'

/**
 * The api layer's own tests.
 *
 * These mount the same `buildApi` the server uses and talk to it with `inject()`,
 * so a route is exercised through the real router, the real schema validation, the
 * real session plugin and the real error mapping, without binding a port. The
 * behaviours worth locking down here are the ones that are decisions rather than
 * plumbing:
 *
 *   - the response envelope, so a client written against one endpoint works
 *   - the k-anonymity floor, which is the platform's central promise
 *   - private contact points, which must not be reachable from a public route
 *   - the rate limit and the capability table, which are how the platform refuses
 */

const PASSWORD = 'Kampala-Reference-2026'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-api-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'api.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  return {
    app,
    server,
    config,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Signs an operator in and returns the bearer token plus the cookie header. */
async function signIn(ctx, { email, role = 'admin' }) {
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Test Operator', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return {
    token: response.json().data.token,
    headers: { authorization: `Bearer ${response.json().data.token}` },
  }
}

/** A leaf category: the marketplace routes require something below the roots. */
function leafCategory(app) {
  for (const root of app.categories.ensureRoots()) {
    for (const branch of app.categories.children(root.id)) {
      const leaf = app.categories.children(branch.id)[0] ?? branch
      return leaf
    }
  }
  throw new Error('the reference dataset has no categories')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

test('health, meta and the reference endpoints answer without a session', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const health = await ctx.server.inject({ method: 'GET', url: '/healthz' })
  assert.equal(health.statusCode, 200)
  assert.equal(health.json().data.status, 'ok')
  assert.equal(health.json().data.migrationsApplied, 7)

  const meta = await ctx.server.inject({ method: 'GET', url: '/api/v1/meta' })
  assert.equal(meta.statusCode, 200)
  assert.equal(meta.json().data.privacy.kThreshold, 5)
  // The seed is what makes those counts non-zero, so this also proves the
  // reference import is reachable from the api, not only from the CLI.
  assert.ok(meta.json().data.counts.locations.city > 0)

  const cities = await ctx.server.inject({ method: 'GET', url: '/api/v1/locations?kind=city' })
  assert.equal(cities.statusCode, 200)
  assert.ok(cities.json().data.length > 0)
  assert.ok(cities.json().data.some((row) => row.name === 'Kampala'))

  const tree = await ctx.server.inject({ method: 'GET', url: '/api/v1/categories' })
  const roots = tree.json().data
  assert.equal(roots.length, 5)
  assert.ok(roots.find((row) => row.slug === 'second-life-electronics').children.length > 0)
})

test('every level the data actually holds can be filtered on by the api', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  // A `kind` filter that rejects a level present in the reference set is a
  // schema that has drifted from the data, which is how `division` and `town`
  // rows became unfetchable. Walk what is really there, level by level.
  const counts = ctx.app.locations.counts()
  const present = Object.entries(counts).filter(([, n]) => n > 0).map(([kind]) => kind)
  assert.ok(present.includes('division'))

  for (const kind of present) {
    const response = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/locations?kind=${kind}&limit=500`,
    })
    assert.equal(response.statusCode, 200, `kind=${kind} should be accepted`)
    const rows = response.json().data
    assert.ok(rows.length > 0, `kind=${kind} should return rows`)
    assert.equal(rows.every((row) => row.kind === kind), true)
  }

  // And a level that does not exist is still refused, so the filter stays useful.
  const bogus = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/locations?kind=moon_base',
  })
  assert.equal(bogus.statusCode, 400)
  assert.equal(bogus.json().error.code, 'request_invalid')
})

test('a list always carries its pagination in meta, never in the body', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const response = await ctx.server.inject({ method: 'GET', url: '/api/v1/locations?limit=2' })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  const total = Object.values(ctx.app.locations.counts()).reduce((sum, n) => sum + n, 0)
  assert.equal(body.data.length, 2)
  assert.deepEqual(body.meta, {
    total,
    limit: 2,
    offset: 0,
    count: 2,
    hasMore: true,
  })
  // `data` must be the list and nothing else: a client that paginates should
  // never have to guess whether a count came back in the array.
  assert.ok(Array.isArray(body.data))
})

test('every documented filter is honoured rather than quietly ignored', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const { token } = await signIn(ctx, { email: 'owner@kampala.test' })
  const auth = { authorization: `Bearer ${token}` }
  const category = leafCategory(ctx.app)
  const [district] = ctx.app.locations.byKind('district')
  const skill = ctx.app.skills.all()[0]

  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers: auth,
    payload: {
      name: 'Kira Battery Clinic',
      categoryId: category.id,
      locationId: district.id,
      status: 'active',
      capabilityLevel: 'operating',
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const business = created.json().data

  const link = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/admin/businesses/${business.id}/skills`,
    headers: auth,
    payload: { name: skill.name, isPrimary: true },
  })
  assert.equal(link.statusCode, 201, link.body)

  // Each of these has to change the answer. A filter that is accepted and then
  // ignored is worse than an absent one, because the caller believes it.
  const bySkill = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/businesses?skillId=${skill.id}`,
  })
  assert.equal(bySkill.statusCode, 200)
  assert.deepEqual(bySkill.json().data.map((row) => row.id), [business.id])

  const byCapability = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/businesses?capabilityLevel=operating',
  })
  assert.deepEqual(byCapability.json().data.map((row) => row.id), [business.id])

  const byWrongCapability = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/businesses?capabilityLevel=established',
  })
  assert.deepEqual(byWrongCapability.json().data, [])

  // And the count agrees with the rows, which is the point of a filter.
  const byCategory = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/businesses?categoryId=${category.id}`,
  })
  const filtered = byCategory.json()
  assert.equal(filtered.meta.total, filtered.data.length)
  assert.equal(filtered.meta.total, 1)
})

test('a private contact point is unreachable from the public profile', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const { token } = await signIn(ctx, { email: 'editor@kampala.test' })
  const auth = { authorization: `Bearer ${token}` }

  const [district] = ctx.app.locations.byKind('district')
  const [category] = ctx.app.categories.ensureRoots()

  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers: auth,
    payload: {
      name: 'Nsambya Mobile Fixers',
      categoryId: category.id,
      locationId: district.id,
      status: 'active',
      verificationState: 'verified',
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const business = created.json().data

  const contact = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/admin/businesses/${business.id}/contacts`,
    headers: auth,
    payload: { kind: 'phone', value: '+256700000000', isPublic: false },
  })
  assert.equal(contact.statusCode, 201, contact.body)

  const publicProfile = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/businesses/${business.slug}`,
  })
  assert.equal(publicProfile.statusCode, 200)
  assert.ok(!JSON.stringify(publicProfile.json()).includes('+256700000000'))

  // And the admin profile, which is the only route allowed to see it.
  const adminProfile = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/admin/businesses/${business.id}`,
    headers: auth,
  })
  assert.equal(adminProfile.statusCode, 200)
  assert.match(JSON.stringify(adminProfile.json()), /\+256700000000/)
})

test('a capability that the role does not hold is refused, and a missing session is 401', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const anonymous = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/businesses' })
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.json().error.code, 'unauthenticated')

  const { token } = await signIn(ctx, { email: 'viewer@kampala.test', role: 'viewer' })
  const headers = { authorization: `Bearer ${token}` }

  // A viewer may read businesses but not write them, and the two answers must
  // differ so a client can tell "sign in" from "you may not".
  assert.equal(
    (await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/businesses', headers })).statusCode,
    200,
  )
  const refused = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    // A body that validates, so the refusal can only be the capability check.
    // If the route answered 400 here it would be hiding the real reason behind
    // a validation error, which is its own kind of confusing.
    payload: {
      name: 'Nsambya Tyres',
      categoryId: leafCategory(ctx.app).id,
      locationId: ctx.app.locations.byKind('district')[0].id,
    },
  })
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().error.code, 'forbidden')
  // And nothing was written by the refused call.
  assert.equal(
    (await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/businesses', headers })).json()
      .data.length,
    0,
  )
})

test('a bad sign-in cannot be used to find out which addresses exist', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())
  await signIn(ctx, { email: 'real@kampala.test' })

  const wrongPassword = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'real@kampala.test', password: 'Wrong-Password-2026' },
  })
  const unknownAddress = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'nobody@kampala.test', password: 'Wrong-Password-2026' },
  })

  assert.equal(wrongPassword.statusCode, 401)
  assert.equal(unknownAddress.statusCode, 401)
  assert.equal(wrongPassword.json().error.message, unknownAddress.json().error.message)
  assert.equal(wrongPassword.headers['set-cookie'], undefined)
})

test('a search is recorded as a demand signal, and other queries are not', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const [district] = ctx.app.locations.byKind('district')
  const search = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/search?q=tv+repair&locationId=${district.id}`,
  })
  assert.equal(search.statusCode, 200)
  assert.ok('meta' in search.json())

  const recorded = ctx.app.demand.summary({ since: '2000-01-01' })
  assert.ok(recorded.searches >= 1)
  assert.equal(search.headers['x-demand-signal'], 'recorded')
  // Browsing the directory is not a statement of intent, so it is not counted.
  const before = recorded.searches
  await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
  assert.equal(ctx.app.demand.summary({ since: '2000-01-01' }).searches, before)

  // And a navigation is not demand either, even though it is a real search.
  const noise = await ctx.server.inject({ method: 'GET', url: '/api/v1/search?q=login' })
  assert.equal(noise.statusCode, 200)
  assert.equal(noise.headers['x-demand-signal'], 'ignored')
  assert.equal(ctx.app.demand.summary({ since: '2000-01-01' }).searches, before)
})

test('an aggregate below the k-anonymity floor is withheld, not rounded', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const [district] = ctx.app.locations.byKind('district')
  // Five is the floor, so six actors publish and two do not. Both are recorded
  // through the same repository the api records through, because the rollup is
  // what applies the floor and the point of the test is the answer the reader
  // gets, not the route that recorded the search.
  for (const actor of ['a', 'b', 'c', 'd', 'e', 'f']) {
    ctx.app.demand.recordSearch({
      query: 'wheel alignment',
      locationId: district.id,
      coverageLevel: 'district',
      totalResults: 0,
      actorSeed: `wheel-${actor}`,
    })
  }
  for (const actor of ['a', 'b']) {
    ctx.app.demand.recordSearch({
      query: 'tyre pressure check',
      locationId: district.id,
      coverageLevel: 'district',
      totalResults: 0,
      actorSeed: `tyre-${actor}`,
    })
  }
  // Signals are published from the daily rollup, which in production runs on a
  // schedule; here it runs by hand.
  assert.equal(ctx.app.demand.rollupDay(today()).events, 8)

  const signals = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/insights/signals?from=2000-01-01&locationId=${district.id}&includeSuppressed=true`,
  })
  assert.equal(signals.statusCode, 200)
  const rows = signals.json().data
  assert.ok(rows.length > 0)

  const published = rows.filter((row) => row.phrase === 'wheel alignment')
  const withheld = rows.filter((row) => row.phrase === 'tyre pressure check')
  assert.ok(published.length > 0)
  assert.ok(withheld.length > 0)

  for (const row of published) {
    assert.equal(row.suppressed, false)
    assert.equal(row.distinctActors, 6)
  }
  for (const row of withheld) {
    assert.equal(row.suppressed, true)
    // Withheld means withheld: not rounded, not capped, and not published as
    // "2", which is a small enough number to subtract a person's own search from.
    assert.equal(row.distinctActors, null)
    assert.equal(row.searches, null)
  }

  // The same window without `includeSuppressed` hides the thin signal entirely.
  const publicOnly = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/insights/signals?from=2000-01-01&locationId=${district.id}`,
  })
  assert.ok(publicOnly.json().data.every((row) => !row.suppressed))
})

test('a rate limited endpoint says so with a retry-after, and the limit is enforced', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  // The public request endpoint allows five a minute, which is the endpoint a
  // scraper would hit first.
  const category = leafCategory(ctx.app)
  const [district] = ctx.app.locations.byKind('district')
  const payload = {
    title: 'Borehole pump needed for a school',
    categoryId: category.id,
    locationId: district.id,
  }

  const responses = []
  for (let attempt = 0; attempt < 7; attempt += 1) {
    responses.push(
      await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/requests',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        payload,
      }),
    )
  }

  const refused = responses.filter((response) => response.statusCode === 429)
  assert.ok(refused.length >= 1, 'expected the window to run out')
  const last = refused[refused.length - 1]
  assert.equal(last.json().error.code, 'rate_limited')
  assert.ok(Number(last.headers['retry-after']) >= 1)
  assert.equal(last.headers['x-ratelimit-limit'], '5')
})

test('a marketplace request is anonymous, and only its access token can withdraw it', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const category = leafCategory(ctx.app)
  const [district] = ctx.app.locations.byKind('district')

  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/requests',
    payload: {
      title: 'Looking for a phone screen replacement',
      categoryId: category.id,
      locationId: district.id,
      items: [{ name: 'Phone screen', quantity: 1 }],
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const { reference, accessToken } = created.json().data
  assert.ok(accessToken)
  assert.equal(created.headers.location, `/api/v1/requests/${reference}`)

  // Public read shows the request but never the requester's identity.
  const followed = await ctx.server.inject({ method: 'GET', url: `/api/v1/requests/${reference}` })
  assert.equal(followed.statusCode, 200)
  assert.equal(followed.json().data.status, 'open')
  assert.equal(followed.json().data.requesterUserId ?? null, null)

  const refused = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/requests/${reference}/withdraw`,
    payload: { accessToken: 'a-token-that-was-never-issued' },
  })
  assert.equal(refused.statusCode, 400)

  const withdrawn = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/requests/${reference}/withdraw`,
    payload: { accessToken },
  })
  assert.equal(withdrawn.statusCode, 200, withdrawn.body)
  assert.equal(withdrawn.json().data.status, 'cancelled')
})

test('an unknown route and a schema violation both answer with the error envelope', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const missing = await ctx.server.inject({ method: 'GET', url: '/api/v1/nowhere' })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error.code, 'not_found')
  assert.ok(missing.json().error.requestId)

  const malformed = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'only-an-email' },
  })
  assert.equal(malformed.statusCode, 400)
  assert.equal(malformed.json().error.code, 'request_invalid')
  assert.ok(Array.isArray(malformed.json().error.details.issues))
})
