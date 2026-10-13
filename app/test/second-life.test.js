import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'
import {
  SECOND_LIFE_ACTIVITIES,
  ACTIVITY_CATEGORY_SLUGS,
  categorySlugForActivity,
  activityForCategorySlug,
  activityForOutcome,
  canAdvance,
  nextStages,
  assertAdvance,
  assertDataWipeSatisfied,
  planClose,
  INTAKE_CLOSED_STAGE,
} from '../src/core/secondLife.js'

/**
 * Second Life Electronics.
 *
 * Two kinds of behaviour are worth pinning here, and they are pinned separately.
 *
 * The pure rules — the stage order, the activity/category mapping, the data-wipe
 * rule — are asserted directly against `core/secondLife.js`, because a rule that
 * can only be observed through a database is a rule nobody can read.
 *
 * The operational behaviour — a device walked through the lifecycle and the
 * numbers that fall out of it — goes through the api, because the whole point of
 * a vertical is that it is usable, and a repository that works while the route
 * that reaches it does not is not a feature.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PASSWORD = 'Kampala-Reference-2026'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-second-life-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'second-life.db') })
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

async function signIn(ctx, { email, role = 'admin' }) {
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Intake Operator', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

/** A published-or-not business is enough; an intake only requires that it exists. */
async function makeBusiness(ctx, headers) {
  const root = ctx.app.categories.ensureRoots().find((row) => row.slug === 'second-life-electronics')
  const category = ctx.app.categories.children(root.id)[0]
  const [district] = ctx.app.locations.byKind('district')
  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    payload: { name: 'Kibuli Device Workshop', categoryId: category.id, locationId: district.id, status: 'active' },
  })
  assert.equal(created.statusCode, 201, created.body)
  return created.json().data
}

test('activities map onto the taxonomy subcategories and back', () => {
  assert.equal(SECOND_LIFE_ACTIVITIES.length, 6)
  for (const activity of SECOND_LIFE_ACTIVITIES) {
    const slug = categorySlugForActivity(activity)
    assert.equal(ACTIVITY_CATEGORY_SLUGS[activity], slug)
    // The round trip is the property that matters: a client that reads an
    // activity off an intake and resolves its category must land back where it
    // started, or the two lists are free to drift.
    assert.equal(activityForCategorySlug(slug), activity)
  }
  assert.equal(activityForCategorySlug('not-ours'), null)
})

test('an intake only ever moves forward, and never straight to closed', () => {
  // `closed` is advertised as a legal destination because an operator has to be
  // able to finish a job, but it is reached through the close action, so the stage
  // move itself is still refused below.
  assert.deepEqual(nextStages('received'), ['diagnosed', 'in_progress', 'ready', INTAKE_CLOSED_STAGE])
  assert.equal(canAdvance('diagnosed', 'received'), false)
  assert.equal(canAdvance('received', 'in_progress'), true)
  assert.equal(canAdvance('in_progress', INTAKE_CLOSED_STAGE), false)
  assert.deepEqual(nextStages(INTAKE_CLOSED_STAGE), [])

  // A backward move is a conflict with the world, not a malformed request.
  assert.throws(() => assertAdvance('ready', 'received'), /cannot go from/)
  assert.throws(() => assertAdvance('received', 'received'), /already/)
  assert.throws(() => assertAdvance(INTAKE_CLOSED_STAGE, 'ready'), /closed/)

  // Closing has its own action and must not be smuggled in as a stage move.
  assert.throws(() => assertAdvance('received', INTAKE_CLOSED_STAGE), /outcome rather than a stage move/)
})

test('a device with an outstanding wipe cannot leave the business', () => {
  // The rule fires only where it should: an outstanding, requested wipe, and an
  // outcome that hands the device to somebody who could read it.
  for (const outcome of ['resold', 'parts_recovered', 'recycled', 'returned']) {
    assert.throws(
      () => assertDataWipeSatisfied({ outcome, dataWipeRequested: true, dataWipeCompleted: false }),
      /wipe is outstanding/,
      `${outcome} must require a completed wipe`,
    )
  }
  // Destroyed on site, so nothing leaves: allowed.
  assert.equal(
    assertDataWipeSatisfied({ outcome: 'scrapped', dataWipeRequested: true, dataWipeCompleted: false }),
    true,
  )
  // No wipe was asked for, so there is no promise to keep.
  assert.equal(
    assertDataWipeSatisfied({ outcome: 'resold', dataWipeRequested: false, dataWipeCompleted: false }),
    true,
  )

  // planClose applies the same rule, so the route and the repository cannot
  // disagree about a close.
  assert.throws(
    () =>
      planClose({
        stage: 'ready',
        activity: 'resale',
        outcome: 'resold',
        dataWipeRequested: true,
        dataWipeCompleted: false,
      }),
    /wipe is outstanding/,
  )
  assert.equal(
    planClose({
      stage: 'ready',
      activity: 'repair',
      outcome: 'repaired',
    }),
    'repaired',
  )
})

test('outcomes attribute recovered value back to an activity', () => {
  assert.equal(activityForOutcome('parts_recovered'), 'parts_recovery')
  assert.equal(activityForOutcome('recycled'), 'recycling')
  // A device handed back to its owner and one destroyed leave no activity behind.
  assert.equal(activityForOutcome('returned'), null)
  assert.equal(activityForOutcome('scrapped'), null)
})

test('the vertical table of contents is public and resolves live category ids', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const response = await ctx.server.inject({ method: 'GET', url: '/api/v1/second-life/activities' })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.equal(body.data.length, 6)

  const root = ctx.app.categories.ensureRoots().find((row) => row.slug === 'second-life-electronics')
  for (const entry of body.data) {
    assert.ok(SECOND_LIFE_ACTIVITIES.includes(entry.activity))
    assert.equal(entry.categorySlug, ACTIVITY_CATEGORY_SLUGS[entry.activity])
    const expected = ctx.app.categories.findBySlug(entry.categorySlug, root.id)
    assert.equal(entry.categoryId, expected.id)
  }
})

test('a device can be taken in, worked, and closed with an outcome', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const auth = await signIn(ctx, { email: 'intake@kampala.test' })
  const business = await makeBusiness(ctx, auth)

  // Two things at once: no session is refused, and an operator is accepted.
  const anonymous = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/businesses/${business.id}/intakes`,
    payload: { activity: 'repair', deviceType: 'laptop', receivedCondition: 'faulty' },
  })
  assert.equal(anonymous.statusCode, 401, anonymous.body)

  const created = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/businesses/${business.id}/intakes`,
    headers: auth,
    payload: {
      activity: 'repair',
      deviceType: 'laptop',
      receivedCondition: 'faulty',
      make: 'HP',
      model: 'ProBook',
      ownerRef: 'walk-in 14',
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  const intake = created.json().data
  assert.match(intake.reference, /^SL-\d{4}-\d{5}$/)
  assert.equal(intake.stage, 'received')
  assert.equal(intake.outcome, null)
  // The category is filled in from the activity when the caller does not name one.
  const root = ctx.app.categories.ensureRoots().find((row) => row.slug === 'second-life-electronics')
  assert.equal(intake.categoryId, ctx.app.categories.findBySlug('device-repair', root.id).id)

  // Walk it forward and check the history records each move.
  for (const stage of ['diagnosed', 'in_progress', 'ready']) {
    const moved = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/second-life/intakes/${intake.reference}/advance`,
      headers: auth,
      payload: { stage, note: `Moved to ${stage}.` },
    })
    assert.equal(moved.statusCode, 200, moved.body)
    assert.equal(moved.json().data.stage, stage)
  }

  // A backward move is refused through the api too, not only in core.
  const backward = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${intake.reference}/advance`,
    headers: auth,
    payload: { stage: 'received' },
  })
  assert.equal(backward.statusCode, 409, backward.body)

  const detail = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/second-life/intakes/${intake.reference}`,
    headers: auth,
  })
  assert.equal(detail.statusCode, 200, detail.body)
  const withHistory = detail.json().data
  assert.deepEqual(withHistory.nextStages, ['closed'])
  assert.equal(withHistory.events.length, 4)
  assert.equal(withHistory.events[0].toStage, 'received')
  assert.equal(withHistory.events.at(-1).toStage, 'ready')

  const closed = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${intake.reference}/close`,
    headers: auth,
    payload: { outcome: 'repaired', note: 'Screen and keyboard replaced.' },
  })
  assert.equal(closed.statusCode, 200, closed.body)
  assert.equal(closed.json().data.stage, 'closed')
  assert.equal(closed.json().data.outcome, 'repaired')
  assert.ok(closed.json().data.closedAt)
})

test('the data-wipe promise is enforced end to end, and the summary reports it', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const auth = await signIn(ctx, { email: 'wipe@kampala.test' })
  const business = await makeBusiness(ctx, auth)

  const open = async (payload) => {
    const response = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/second-life/businesses/${business.id}/intakes`,
      headers: auth,
      payload,
    })
    assert.equal(response.statusCode, 201, response.body)
    return response.json().data
  }

  // A recycler takes in a dead laptop whose owner wants the disk wiped.
  const toRecycle = await open({
    activity: 'recycling',
    deviceType: 'laptop',
    receivedCondition: 'for_parts',
    dataWipeRequested: true,
  })

  // It cannot be closed as recycled while the wipe is outstanding.
  const blocked = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${toRecycle.reference}/close`,
    headers: auth,
    payload: { outcome: 'recycled' },
  })
  assert.equal(blocked.statusCode, 409, blocked.body)
  assert.equal(blocked.json().error.code, 'conflict')

  // Recording the wipe unblocks it.
  const wiped = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${toRecycle.reference}/wipe`,
    headers: auth,
    payload: { note: 'Drive overwritten.' },
  })
  assert.equal(wiped.statusCode, 200, wiped.body)
  assert.equal(wiped.json().data.dataWipeCompleted, true)

  const recycled = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${toRecycle.reference}/close`,
    headers: auth,
    payload: { outcome: 'recycled' },
  })
  assert.equal(recycled.statusCode, 200, recycled.body)
  assert.equal(recycled.json().data.outcome, 'recycled')

  // A device destroyed on site needs no wipe, because nothing leaves.
  const scrapped = await open({
    activity: 'recycling',
    deviceType: 'battery',
    receivedCondition: 'water_damaged',
    dataWipeRequested: true,
  })
  const destroyed = await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${scrapped.reference}/close`,
    headers: auth,
    payload: { outcome: 'scrapped' },
  })
  assert.equal(destroyed.statusCode, 200, destroyed.body)

  // One repaired job, so the summary has more than the recycling activity in it.
  const repaired = await open({ activity: 'repair', deviceType: 'smartphone', receivedCondition: 'faulty' })
  await ctx.server.inject({
    method: 'POST',
    url: `/api/v1/second-life/intakes/${repaired.reference}/close`,
    headers: auth,
    payload: { outcome: 'repaired', dataWipeCompleted: true },
  })

  const summary = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/second-life/businesses/${business.id}/summary`,
    headers: auth,
  })
  assert.equal(summary.statusCode, 200, summary.body)
  const data = summary.json().data
  assert.equal(data.closed, 3)
  assert.equal(data.open, 0)
  assert.equal(data.outcomes.recycled, 1)
  assert.equal(data.outcomes.repaired, 1)
  assert.equal(data.outcomes.scrapped, 1)
  // The pair that makes the data promise visible: two wipes were asked for, and
  // only the one on the device that actually left the business was carried out.
  // The scrapped battery was destroyed on site, so its request never became a risk.
  assert.deepEqual(data.dataWipes, { requested: 2, completed: 1 })
})

test('a business only ever sees its own intake book', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const auth = await signIn(ctx, { email: 'books@kampala.test' })
  const mine = await makeBusiness(ctx, auth)
  const other = await makeBusiness(ctx, auth)

  for (const business of [mine, other]) {
    await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/second-life/businesses/${business.id}/intakes`,
      headers: auth,
      payload: { activity: 'repair', deviceType: 'smartphone', receivedCondition: 'working' },
    })
  }

  const listed = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/second-life/businesses/${mine.id}/intakes`,
    headers: auth,
  })
  assert.equal(listed.statusCode, 200, listed.body)
  const body = listed.json()
  assert.equal(body.meta.total, 1)
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].businessId, mine.id)

  // Filtering by a stage with nothing in it returns nothing rather than everything,
  // which is the failure a missing WHERE clause produces.
  const closed = await ctx.server.inject({
    method: 'GET',
    url: `/api/v1/second-life/businesses/${mine.id}/intakes?stage=closed`,
    headers: auth,
  })
  assert.equal(closed.statusCode, 200, closed.body)
  assert.equal(closed.json().meta.total, 0)
})

test('the reference data file and the vertical agree on the six subcategories', () => {
  // Guards against the reference dataset and core/secondLife.js drifting: if a
  // subcategory is renamed in one place, this is where it is caught rather than in
  // a production resolution that silently returns null.
  const source = fs.readFileSync(path.join(APP_ROOT, 'src', 'seed', 'reference-data.js'), 'utf8')
  for (const slug of Object.values(ACTIVITY_CATEGORY_SLUGS)) {
    assert.ok(
      source.includes(`second-life-electronics/${slug}`),
      `reference-data.js is missing second-life-electronics/${slug}`,
    )
  }
})
