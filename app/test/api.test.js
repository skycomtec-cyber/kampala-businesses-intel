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
  assert.equal(health.json().data.migrationsApplied, 9)

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

  // The public list only answers with records the platform stands behind, so a
  // listing that is still in the queue has to be driven to `approved` through the
  // review pipeline before any of the filters below can see it. Creating it and
  // then filtering for it used to be enough, back when `active` was the only bar.
  assert.equal(business.verificationState, 'pending_review')
  assert.deepEqual((await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })).json().data, [])

  const submitted = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/admin/businesses/${business.id}/verification`,
    headers: auth,
    payload: { action: 'verify', reason: 'Checked the details against the source.' },
  })
  assert.equal(submitted.statusCode, 200, submitted.body)
  const approved = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/admin/businesses/${business.id}/verification`,
    headers: auth,
    payload: { action: 'approve', reason: 'Published in the directory.' },
  })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.equal(approved.json().data.verificationState, 'approved')

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

  // The other half of the promise: a filter this api does not have is refused
  // rather than dropped. `verificationStatus` is the spelling a caller reaches
  // for first, and while it was ignored the answer was every listing.
  const misspelled = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/businesses?verificationStatus=verified',
  })
  assert.equal(misspelled.statusCode, 400)
  assert.equal(misspelled.json().error.code, 'request_invalid')

  // `verificationState` is not misspelled, it is a different question, and it is
  // a question only the review queue is allowed to ask. The public list answers
  // `approved` and nothing else, so there is no parameter to supply.
  const notOnPublic = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/businesses?verificationState=rejected',
  })
  assert.equal(notOnPublic.statusCode, 400)
  assert.equal(notOnPublic.json().error.code, 'request_invalid')

  const misspelledInTheQueue = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/businesses?verificationStatus=unverified',
    headers: auth,
  })
  assert.equal(misspelledInTheQueue.statusCode, 400)
  assert.equal(misspelledInTheQueue.json().error.code, 'request_invalid')
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
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const business = created.json().data

  // Approved through the pipeline rather than created approved, because a
  // listing nobody reviewed has no public profile to leak a phone number from,
  // and a test that 404s for that reason is testing the wrong thing.
  for (const [action, reason] of [
    ['verify', 'Checked the details against the source.'],
    ['approve', 'Published in the directory.'],
  ]) {
    const step = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${business.id}/verification`,
      headers: auth,
      payload: { action, reason },
    })
    assert.equal(step.statusCode, 200, step.body)
  }

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

  // The public listing page shares the repository with the admin queue, so it is
  // the route most likely to inherit the contact evidence by accident. It gets
  // no contact field at all rather than a filtered one.
  const publicList = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
  assert.equal(publicList.statusCode, 200)
  assert.ok(!JSON.stringify(publicList.json()).includes('+256700000000'))
  assert.equal(publicList.json().data[0].contacts, undefined)
  assert.equal(publicList.json().data[0].contactCount, undefined)

  // And the admin profile, which is the only route allowed to see it.
  const adminProfile = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/admin/businesses/${business.id}`,
    headers: auth,
  })
  assert.equal(adminProfile.statusCode, 200)
  assert.match(JSON.stringify(adminProfile.json()), /\+256700000000/)

  // The admin queue carries the contact evidence per row, so a page of listings
  // is reviewed without opening each one.
  const adminList = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/businesses',
    headers: auth,
  })
  assert.equal(adminList.statusCode, 200)
  const row = adminList.json().data.find((item) => item.id === business.id)
  assert.equal(row.contactCount, 1)
  assert.equal(row.publicContactCount, 0)
  assert.match(row.contacts[0].value, /\+256700000000/)
})

test('an imported queue can be worked through in batches', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const { token } = await signIn(ctx, { email: 'editor@kampala.test', role: 'editor' })
  const headers = { authorization: `Bearer ${token}` }
  const category = leafCategory(ctx.app)
  const district = ctx.app.locations.byKind('district')[0]

  // What an import leaves behind: active, waiting for review, and with a phone
  // number that is not public because nobody confirmed the shop wants it listed.
  const created = []
  for (const [name, phone] of [
    ['Nakawa Kiosk', '0772000001'],
    ['Kireka Salon', '0772000002'],
    ['Ntinda Chemist', '0772000003'],
  ]) {
    const response = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/businesses',
      headers,
      payload: { name, categoryId: category.id, locationId: district.id, status: 'active' },
    })
    assert.equal(response.statusCode, 201, response.body)
    const business = response.json().data
    await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${business.id}/contacts`,
      headers,
      payload: { kind: 'phone', value: phone, isPublic: false },
    })
    created.push(business)
  }

  // The queue has to be readable in one call. A row that hides its phone number
  // until it is fetched separately cannot be reviewed, and three listings is
  // four requests.
  const queue = await ctx.server.inject({
    method: 'GET',
    url: '/api/v1/admin/businesses?verificationState=pending_review&sort=newest',
    headers,
  })
  assert.equal(queue.statusCode, 200)
  const rows = queue.json().data
  assert.equal(rows.length, 3)
  assert.equal(rows[0].contactCount, 1)
  assert.equal(rows[0].publicContactCount, 0, 'an imported number is not public yet')
  assert.ok(rows.every((row) => row.contacts.length === 1))

  // Nothing in the queue is public yet, and the public surfaces have to agree.
  const publicBefore = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
  assert.deepEqual(publicBefore.json().data, [])

  const ids = created.map((row) => row.id)
  const decision = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers,
    payload: {
      ids: [...ids, '00000000-0000-4000-8000-000000000000'],
      action: 'verify',
      reason: 'Surveyed in person on 2026-09-25; every shop confirmed it trades here.',
    },
  })
  assert.equal(decision.statusCode, 200, decision.body)
  assert.deepEqual(decision.json().data.counts, { updated: 3, unchanged: 0, refused: 0, missing: 1 })
  assert.equal(decision.json().data.rows.find((row) => row.outcome === 'missing').id,
    '00000000-0000-4000-8000-000000000000')

  // Verified is not published. The listing is checked but nobody has agreed to
  // put it in the directory, and the public endpoints have to reflect that.
  const stillHidden = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
  assert.deepEqual(stillHidden.json().data, [])
  const verifiedProfile = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/businesses/${created[0].slug}`,
  })
  assert.equal(verifiedProfile.statusCode, 404, 'a verified-but-unapproved listing is not public')

  // Every decision says why, in the log, against the entity.
  for (const business of created) {
    const entries = ctx.app.audit.forEntity('business', business.id)
    const verify = entries.find((entry) => entry.action === 'business.verify')
    assert.equal(
      verify.reason,
      'Surveyed in person on 2026-09-25; every shop confirmed it trades here.',
    )
  }

  // A retried request must not churn the log: an id already in that state is
  // reported as unchanged, not rewritten a hundred times.
  const retry = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers,
    payload: {
      ids,
      action: 'verify',
      reason: 'Surveyed in person on 2026-09-25; every shop confirmed it trades here.',
    },
  })
  assert.deepEqual(retry.json().data.counts, { updated: 0, unchanged: 3, refused: 0, missing: 0 })
  assert.equal(
    ctx.app.audit
      .forEntity('business', created[0].id)
      .filter((entry) => entry.action === 'business.verify').length,
    1,
    'the retry decided nothing, so it wrote nothing',
  )

  // A decision without a reason is refused: "verified" with no stated basis is
  // indistinguishable from somebody pressing a button.
  const noReason = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers,
    payload: { ids, action: 'reject' },
  })
  assert.equal(noReason.statusCode, 400, noReason.body)

  // And one request cannot decide the whole directory.
  const tooMany = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers,
    payload: {
      ids: Array.from({ length: 101 }, () => ids[0]),
      action: 'verify',
      reason: 'x'.repeat(4),
    },
  })
  assert.equal(tooMany.statusCode, 400)

  // An editor may decide, a viewer may not.
  const { token: viewerToken } = await signIn(ctx, {
    email: 'viewer@kampala.test',
    role: 'viewer',
  })
  const refused = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { ids, action: 'verify', reason: 'because' },
  })
  assert.equal(refused.statusCode, 403)

  // Checking a listing and publishing it are different decisions, so they are
  // different capabilities. An editor can do the first and is refused the second,
  // and the refusal is a permission error rather than a validation error, so the
  // client can tell the operator why.
  const editorPublish = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers,
    payload: { ids, action: 'approve', reason: 'The editor believes these are real.' },
  })
  assert.equal(editorPublish.statusCode, 403, editorPublish.body)
  assert.equal(editorPublish.json().error.code, 'forbidden')

  // An administrator can, and publishing is what makes the listings visible.
  const { token: adminToken } = await signIn(ctx, { email: 'owner@kampala.test' })
  const approved = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses/verification',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { ids, action: 'approve', reason: 'Reviewed and approved for the directory.' },
  })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.deepEqual(approved.json().data.counts, { updated: 3, unchanged: 0, refused: 0, missing: 0 })

  const publicAfter = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
  assert.equal(publicAfter.json().data.length, 3)
  const profile = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/businesses/${created[0].slug}`,
  })
  assert.equal(profile.statusCode, 200)
  // Publishing the listing is still not publishing the number typed off a
  // shopfront, so the number stays out of the public payload.
  assert.ok(!JSON.stringify(profile.json()).includes('0772000001'))

  // And each listing carries the decisions that got it there, in order. Verifying
  // something nobody had claimed is not refused: it implies the claim, and both
  // are written, so the history says a reviewer picked it up rather than leaving
  // a gap between "queued" and "checked".
  const events = ctx.app.catalogue.eventsFor(created[0].id)
  assert.deepEqual(events.map((event) => event.action), ['claim', 'verify', 'approve'])
  assert.deepEqual(
    events.map((event) => [event.fromState, event.toState]),
    [
      ['pending_review', 'under_review'],
      ['under_review', 'verified'],
      ['verified', 'approved'],
    ],
  )
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

test('every signed-in route refuses an anonymous caller, however it declares the check', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  // Table driven on purpose. `preHandler` is a route option, not part of the
  // schema, and Fastify ignores an unknown key inside `schema` without a word.
  // A check written in the wrong place therefore looks present in review, shows
  // up in the openapi document as ordinary metadata, and protects nothing. This
  // test is the only thing that notices.
  const signedInOnly = [
    { method: 'GET', url: '/api/v1/auth/me' },
    { method: 'GET', url: '/api/v1/auth/roles' },
    { method: 'POST', url: '/api/v1/auth/logout' },
    {
      method: 'POST',
      url: '/api/v1/auth/change-password',
      payload: { currentPassword: PASSWORD, newPassword: 'Kampala-New-2026' },
    },
  ]

  for (const route of signedInOnly) {
    const response = await ctx.server.inject(route)
    assert.equal(response.statusCode, 401, `${route.method} ${route.url} answered ${response.statusCode}`)
    assert.equal(response.json().error.code, 'unauthenticated', route.url)
  }

  // And with a session the same routes work, so the refusals above are the
  // check and not a route that is simply broken.
  const { headers } = await signIn(ctx, { email: 'operator@kampala.test' })
  const me = await ctx.server.inject({ method: 'GET', url: '/api/v1/auth/me', headers })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().data.user.email, 'operator@kampala.test')
  assert.ok(me.json().data.session.expiresAt, 'the session expiry travels with the identity')
})

test('a bug in our own code is reported as a 500, not as the caller being wrong', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  ctx.server.get('/test/unexpected', async () => {
    throw new TypeError("Cannot read properties of null (reading 'expiresAt')")
  })
  const response = await ctx.server.inject({ method: 'GET', url: '/test/unexpected' })

  // A thrown TypeError carries no domain code. It used to fall through to 400,
  // which told the caller their request was malformed, kept it out of the branch
  // that logs a stack, and hid a missing auth check for months behind an
  // `internal_error` that read like a bad request.
  assert.equal(response.statusCode, 500)
  assert.equal(response.json().error.code, 'internal_error')
  assert.equal(response.json().error.message, 'The request could not be completed.')
  // A crash must not carry our internals to the caller.
  assert.ok(!response.body.includes('TypeError'))
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

test('the catalogue is administered over http, and trust is a decision', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const { token } = await signIn(ctx, { email: 'curator@kampala.test' })
  const headers = { authorization: `Bearer ${token}` }

  // Registering a source. The key is derived from the name, and the counts come
  // back zero because nothing has come through it yet.
  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/catalogue/sources',
    headers,
    payload: {
      name: 'Uganda Business Registry',
      type: 'api',
      trustLevel: 'controlled',
      uri: 'https://example.invalid/registry',
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const source = created.json().data
  assert.equal(source.key, 'uganda-business-registry')
  assert.equal(source.recordCount, 0)
  assert.equal(source.pendingCount, 0)

  // The same name twice returns the same source, because the seed runs on every
  // start and a register that grows a "-2" on each launch is not a register.
  const again = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/catalogue/sources',
    headers,
    payload: { name: 'Uganda Business Registry', type: 'api' },
  })
  assert.equal(again.statusCode, 201)
  assert.equal(again.json().data.id, source.id)
  assert.equal(
    (await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/catalogue/sources', headers }))
      .json()
      .meta.total,
    // The migration seeds `legacy-directory`, so this is never 1.
    ctx.app.catalogue.allSources().length,
  )

  // A source whose trust level is not a level the platform knows is refused at
  // the edge, before anything is written.
  const nonsense = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/catalogue/sources',
    headers,
    payload: { name: 'A Rumour', type: 'community', trustLevel: 'trusts-me' },
  })
  assert.equal(nonsense.statusCode, 400)
  assert.equal(nonsense.json().error.code, 'request_invalid')

  // An editor can run an import and therefore needs to see where a record came
  // from, but registering a new source is a statement about the whole directory's
  // facts and is not theirs to make.
  const { token: editorToken } = await signIn(ctx, { email: 'editor2@kampala.test', role: 'editor' })
  const editorHeaders = { authorization: `Bearer ${editorToken}` }
  assert.equal(
    (await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/catalogue/sources', headers: editorHeaders }))
      .statusCode,
    200,
  )
  const editorWrite = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/catalogue/sources',
    headers: editorHeaders,
    payload: { name: 'Editor Source', type: 'manual' },
  })
  assert.equal(editorWrite.statusCode, 403)
  assert.equal(ctx.app.catalogue.findSourceByKey('editor-source'), null)

  // The queue reports every *open* step with a zero, because a queue of a
  // thousand waiting and nothing verified reads as a healthy pipeline until
  // somebody notices the public count has not moved.
  const queue = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/catalogue/queue', headers })
  assert.equal(queue.statusCode, 200, queue.body)
  assert.equal(queue.json().meta.total, 0)
  assert.deepEqual(queue.json().meta.counts, {
    imported: 0,
    pending_review: 0,
    under_review: 0,
    verified: 0,
  })
  // `approved` and `rejected` are outcomes, not work waiting, so they are not
  // backlog. A queue of four hundred approved listings is not a queue of four
  // hundred problems.
  assert.equal('approved' in queue.json().meta.counts, false)

  // A record that arrived with nothing saying where it came from is listed, not
  // hidden. This is the honest report of the gap the migration left behind.
  const createdBusiness = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    payload: {
      name: 'Unproven Co',
      categoryId: leafCategory(ctx.app).id,
      locationId: ctx.app.locations.byKind('district')[0].id,
    },
  })
  assert.equal(createdBusiness.statusCode, 201, createdBusiness.body)
  const orphans = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/catalogue/orphans', headers })
  assert.equal(orphans.json().meta.total, 1)
  assert.equal(orphans.json().data[0].id, createdBusiness.json().data.id)

  // Retiring stops the source supplying records but leaves it readable, because
  // the records it brought in still have to say where they came from.
  const retired = await ctx.server.inject({
    method: 'DELETE',
    url: `/api/v1/admin/catalogue/sources/${source.id}`,
    headers,
  })
  assert.equal(retired.statusCode, 200, retired.body)
  assert.equal(retired.json().data.isActive, false)
  assert.equal(
    (await ctx.server.inject({ method: 'GET', url: `/api/v1/admin/catalogue/sources/${source.id}`, headers }))
      .statusCode,
    200,
  )
})
