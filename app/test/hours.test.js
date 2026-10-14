import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'
import {
  TZ_OFFSET_MINUTES,
  WEEKDAYS,
  parseTime,
  formatTime,
  buildHours,
  validateWeek,
  weekFromRows,
  rowsFromWeek,
  isOpenAt,
  describeState,
} from '../src/core/hours.js'

/**
 * Opening hours.
 *
 * The whole point of the feature is the sentence "is it open now", so the tests
 * are mostly about that sentence and the two ways it can be wrong: a schedule
 * that lies about a night shift, and a label that disagrees with the badge.
 *
 * `describeState` takes the moment as an argument, so the clock is not mocked:
 * the tests hand it a fixed instant and read the same answer the api would.
 */

const PASSWORD = 'Kampala-Reference-2026'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-hours-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'hours.db') })
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
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Hours Editor', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

async function makeBusiness(ctx, headers, name = 'Bukoto Hardware') {
  const [district] = ctx.app.locations.byKind('district')
  const root = ctx.app.categories.ensureRoots()[1]
  const category = ctx.app.categories.children(root.id)[0]
  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    payload: { name, categoryId: category.id, locationId: district.id, status: 'active' },
  })
  assert.equal(created.statusCode, 201, created.body)
  return created.json().data
}

/** Monday to Friday, 09:00 to 17:00. The reference week for most tests. */
function weekdayWeek() {
  return WEEKDAYS.filter((day) => day.weekday <= 5).map((day) => ({
    weekday: day.weekday,
    opens: '09:00',
    closes: '17:00',
  }))
}

/* --- the rules --------------------------------------------------------------- */

test('a time is read to the minute, and stored looking the way it was typed', () => {
  assert.equal(TZ_OFFSET_MINUTES, 180)
  assert.equal(parseTime('09:00'), 540)
  assert.equal(parseTime('9:00'), 540)
  assert.equal(parseTime('00:00'), 0)
  assert.equal(formatTime(540), '09:00')
  assert.equal(formatTime(0), '00:00')
  // A closing time that wraps past midnight formats without sign, because the
  // weekend is a number of minutes and not an arithmetic result.
  assert.equal(formatTime(120), '02:00')

  assert.throws(() => parseTime('9'), /HH:MM/)
  assert.throws(() => parseTime('25:00'), /00:00 and 23:59/)
  assert.throws(() => parseTime('09:60'), /00:00 and 23:59/)
})

test('a day is either closed with no times or open with both', () => {
  assert.deepEqual(buildHours({ weekday: 2, isClosed: true }), {
    weekday: 2,
    isClosed: true,
    opens: null,
    closes: null,
  })
  // Closing is explicit, and a closed day ignores whatever times came with it.
  assert.equal(buildHours({ weekday: 2, isClosed: true, opens: '09:00' }).opens, null)

  assert.throws(() => buildHours({ weekday: 8 }), /1 \(Monday\) to 7 \(Sunday\)/)
  assert.throws(() => buildHours({ weekday: 1, opens: '09:00' }), /opening and a closing/)
  // Equal times are the one ambiguity that cannot be guessed, so it is refused.
  assert.throws(() => buildHours({ weekday: 1, opens: '09:00', closes: '09:00' }), /same/)
})

test('a week is always seven days, in order, with the missing ones closed', () => {
  const week = validateWeek(weekdayWeek())
  assert.equal(week.length, 7)
  assert.deepEqual(
    week.map((day) => day.weekday),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.equal(week[0].opens, '09:00')
  assert.equal(week[5].isClosed, true, 'Saturday was not submitted, so it is closed')
  assert.equal(week[6].isClosed, true)

  assert.throws(
    () => validateWeek([{ weekday: 3, isClosed: true }, { weekday: 3, isClosed: true }]),
    /only appear once/,
  )

  // Rows out of the database have the shape the rules expect, so a stored week
  // and a submitted week are the same object.
  assert.deepEqual(weekFromRows(rowsFromWeek(week)), week)
})

test('a night shift is open past midnight, and read on the right day', () => {
  const week = validateWeek([{ weekday: 1, opens: '20:00', closes: '02:00' }])
  // Monday 23:00 EAT.
  assert.equal(isOpenAt(week, { weekday: 1, minutes: 23 * 60 }), true)
  // Tuesday 01:00 EAT is still Monday's shift.
  assert.equal(isOpenAt(week, { weekday: 2, minutes: 60 }), true)
  // Tuesday 03:00 EAT is after it.
  assert.equal(isOpenAt(week, { weekday: 2, minutes: 180 }), false)
  // Sunday into Monday: Monday is the start of the week, so there is no spill.
  assert.equal(isOpenAt(week, { weekday: 1, minutes: 30 }), false)
})

test('the sentence says whether it is open, until when, and when next', () => {
  const week = validateWeek(weekdayWeek())

  // Wednesday 09:30 EAT.
  const openNow = describeState(week, new Date('2026-10-14T06:30:00Z'))
  assert.equal(openNow.open, true)
  assert.equal(openNow.recorded, true)
  assert.equal(openNow.closesAt, '17:00')
  assert.match(openNow.label, /Open now · closes 17:00/)

  // Wednesday 08:00 EAT, before the doors open.
  const beforeOpen = describeState(week, new Date('2026-10-14T05:00:00Z'))
  assert.equal(beforeOpen.open, false)
  assert.equal(beforeOpen.label, 'Closed · opens today 09:00')
  assert.deepEqual(beforeOpen.nextOpens, { weekday: 3, time: '09:00' })

  // Wednesday 18:00 EAT, after close.
  const afterClose = describeState(week, new Date('2026-10-14T15:00:00Z'))
  assert.equal(afterClose.label, 'Closed · opens tomorrow 09:00')

  // Saturday 10:00 EAT: the next opening is Monday, so it is named, not "in 2 days".
  const weekend = describeState(week, new Date('2026-10-17T07:00:00Z'))
  assert.equal(weekend.label, 'Closed · opens Monday 09:00')

  // A business that never recorded hours says so, rather than "closed".
  const unknown = describeState(validateWeek([]), new Date('2026-10-14T06:30:00Z'))
  assert.deepEqual(unknown, {
    open: false,
    recorded: false,
    label: 'Opening hours not recorded',
  })
})

/* --- the flow ---------------------------------------------------------------- */

test('an editor records a week, and the public profile computes open state from it', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makeBusiness(ctx, admin)

    const saved = await ctx.server.inject({
      method: 'PUT',
      url: `/api/v1/admin/businesses/${business.id}/hours`,
      headers: admin,
      payload: { week: weekdayWeek() },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const week = saved.json().data.hours
    assert.equal(week.length, 7)
    assert.equal(week[0].opens, '09:00')
    assert.equal(week[6].isClosed, true)

    // The admin profile carries the recorded week.
    const adminProfile = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/admin/businesses/${business.id}`,
      headers: admin,
    })
    assert.equal(adminProfile.json().data.hours.length, 7)

    // A malformed week is a 400, not a silently dropped day.
    const bad = await ctx.server.inject({
      method: 'PUT',
      url: `/api/v1/admin/businesses/${business.id}/hours`,
      headers: admin,
      payload: { week: [{ weekday: 1, opens: '09:00', closes: '09:00' }] },
    })
    assert.equal(bad.statusCode, 400, bad.body)

    // The listing only becomes public once it is reviewed, and when it does the
    // open state is derived, not stored.
    const verified = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${business.id}/verification`,
      headers: admin,
      payload: { action: 'verify', reason: 'Checked the shopfront on a site visit.' },
    })
    assert.equal(verified.statusCode, 200, verified.body)
    const approved = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${business.id}/verification`,
      headers: admin,
      payload: { action: 'approve', reason: 'Ready for the directory.' },
    })
    assert.equal(approved.statusCode, 200, approved.body)

    const profile = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/businesses/${business.slug}`,
    })
    assert.equal(profile.statusCode, 200, profile.body)
    const data = profile.json().data
    assert.equal(data.hours.length, 7)
    assert.equal(data.openState.recorded, true)
    assert.equal(typeof data.openState.open, 'boolean')
    assert.match(data.openState.label, /^(Open now|Closed)/)

    // The directory rows carry the same badge, so a list and the page it links
    // to cannot disagree.
    const list = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().data[0].openState.recorded, true)
  } finally {
    await ctx.cleanup()
  }
})

test('a provider owns the hours, but only for its own listing', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makeBusiness(ctx, admin)

    // No account, no desk.
    const anonymous = await ctx.server.inject({
      method: 'PUT',
      url: `/api/v1/provider/businesses/${business.id}/hours`,
      payload: { week: weekdayWeek() },
    })
    assert.equal(anonymous.statusCode, 401, anonymous.body)

    // An admin is not a provider, so the provider route refuses it.
    const adminAtDesk = await ctx.server.inject({
      method: 'PUT',
      url: `/api/v1/provider/businesses/${business.id}/hours`,
      headers: admin,
      payload: { week: weekdayWeek() },
    })
    assert.equal(adminAtDesk.statusCode, 403, adminAtDesk.body)
  } finally {
    await ctx.cleanup()
  }
})
