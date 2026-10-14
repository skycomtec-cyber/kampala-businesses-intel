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
  EARTH_RADIUS_KM,
  normalisePoint,
  normaliseRadius,
  haversineKm,
  roundKm,
  boundingBox,
} from '../src/core/geo.js'

/**
 * "Near me" and the distance behind it.
 *
 * The feature is two questions that must agree: is two points this many
 * kilometres apart (the pure maths), and does the directory return the same
 * answer for the reader (the query). The first is checked against numbers a
 * reader can verify by eye — one degree of longitude at the equator, the
 * symmetry of a→b and b→a, a point with itself being nothing away — and the
 * second against four seeded towns whose coordinates are already in the
 * reference data, so the expected distances come from real Ugandan places
 * rather than from the same function under test.
 *
 * The clock does not matter here; nothing in this feature is time-dependent.
 */

const PASSWORD = 'Kampala-Reference-2026'

/** The centre every distance in this file is measured from: central Kampala. */
const KAMPALA = { lat: 0.3476, lng: 32.5825 }

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-geo-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'geo.db') })
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
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Geo Editor', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

function findLocation(ctx, kind, name) {
  const found = ctx.app.locations.byKind(kind).find((loc) => loc.name === name)
  assert.ok(found, `expected the reference data to contain a ${kind} called ${name}`)
  return found
}

/** Creates a business at a known place and walks it all the way to published. */
async function makePublished(ctx, headers, name, location) {
  const root = ctx.app.categories.ensureRoots()[1]
  const category = ctx.app.categories.children(root.id)[0]
  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    payload: { name, categoryId: category.id, locationId: location.id, status: 'active' },
  })
  assert.equal(created.statusCode, 201, created.body)
  const id = created.json().data.id

  for (const action of ['verify', 'approve']) {
    const step = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${id}/verification`,
      headers,
      payload: { action, reason: 'Checked the shopfront on a site visit.' },
    })
    assert.equal(step.statusCode, 200, step.body)
  }
  return created.json().data
}

/* --- the maths --------------------------------------------------------------- */

test('a distance is the shortest way round the sphere, and is symmetric', () => {
  assert.equal(haversineKm(KAMPALA, KAMPALA), 0)

  // One degree of longitude along the equator is the definition of a
  // degree of the earth: 6371 km x pi/180.
  const oneDegree = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
  assert.ok(
    Math.abs(oneDegree - (EARTH_RADIUS_KM * Math.PI) / 180) < 1e-6,
    `expected one equatorial degree, got ${oneDegree}`,
  )
  // ~111 km, which is the figure anybody would sanity-check this against.
  assert.ok(oneDegree > 111 && oneDegree < 112, String(oneDegree))

  const a = KAMPALA
  const b = { lat: 0.0512, lng: 32.4633 } // Entebbe
  assert.ok(Math.abs(haversineKm(a, b) - haversineKm(b, a)) < 1e-9, 'a to b must equal b to a')

  // Two points on opposite sides of the planet are not further than a
  // half-circumference, because there is no other way round.
  const antipodal = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })
  assert.ok(Math.abs(antipodal - Math.PI * EARTH_RADIUS_KM) < 1e-6, String(antipodal))
})

test('a place is a latitude and a longitude, or it is nothing', () => {
  assert.deepEqual(normalisePoint({ lat: 0.35, lng: 32.58 }), { lat: 0.35, lng: 32.58 })

  // Neither coordinate is not a location, and the caller is asking a different
  // question — that is not an error, it is simply absent.
  assert.equal(normalisePoint({}), null)
  assert.equal(normalisePoint({ lat: null, lng: null }), null)
  assert.equal(normalisePoint(undefined), null)

  // Half a coordinate is refused rather than defaulted to a guessed place.
  assert.throws(() => normalisePoint({ lat: 0.35 }), /both a latitude and a longitude/)
  assert.throws(() => normalisePoint({ lng: 32.58 }), /both a latitude and a longitude/)

  // Out-of-bounds is a real coordinate, just not one on this earth.
  assert.throws(() => normalisePoint({ lat: 91, lng: 0 }), /between -90 and 90/)
  assert.throws(() => normalisePoint({ lat: 0, lng: 181 }), /between -180 and 180/)
  assert.throws(() => normalisePoint({ lat: 'north', lng: 0 }), /between -90 and 90/)
})

test('a radius is a real number of kilometres, not a blank or a planet', () => {
  assert.equal(normaliseRadius(3), 3)
  assert.equal(normaliseRadius('2.5'), 2.5)

  // Absent means "no radius", which the repository reads as no distance filter.
  assert.equal(normaliseRadius(undefined), null)
  assert.equal(normaliseRadius(''), null)
  assert.equal(normaliseRadius(null), null)

  assert.throws(() => normaliseRadius(0), /positive/)
  assert.throws(() => normaliseRadius(-5), /positive/)
  assert.throws(() => normaliseRadius('near'), /positive/)
  // A radius larger than the platform serves is refused rather than turned into
  // a full-table list sorted by a number that means nothing at that scale.
  assert.throws(() => normaliseRadius(1000), /500/)
  assert.equal(normaliseRadius(500), 500)
})

test('the bounding box always contains the circle it was drawn for', () => {
  const box = boundingBox(KAMPALA, 10)
  assert.ok(box.minLat <= KAMPALA.lat && KAMPALA.lat <= box.maxLat)
  assert.ok(box.minLng <= KAMPALA.lng && KAMPALA.lng <= box.maxLng)

  // Every corner of a box drawn for 10 km is itself within 10 km of the centre
  // as the crow flies? No — the corners are further, because a square is wider
  // than its inscribed circle. What must hold is that the box is not *smaller*
  // than the circle: a point at the radius on each axis stays inside.
  for (const probe of [
    { lat: KAMPALA.lat, lng: KAMPALA.lng + 10 / 111.32 },
    { lat: KAMPALA.lat - 10 / 111.32, lng: KAMPALA.lng },
  ]) {
    assert.ok(probe.lat >= box.minLat && probe.lat <= box.maxLat, 'lat edge outside the box')
    assert.ok(probe.lng >= box.minLng && probe.lng <= box.maxLng, 'lng edge outside the box')
  }

  // A box never runs off the edge of the world.
  const polar = boundingBox({ lat: 89.9, lng: 10 }, 500)
  assert.ok(polar.maxLat <= 90 && polar.minLat >= -90)
  assert.ok(polar.maxLng <= 180 && polar.minLng >= -180)
})

test('a distance is rounded to a tenth of a kilometre for display', () => {
  assert.equal(roundKm(0), 0)
  assert.equal(roundKm(1.96), 2)
  assert.equal(roundKm(1.94), 1.9)
  assert.equal(roundKm(0.554), 0.6)
})

/* --- the flow ---------------------------------------------------------------- */

test('the directory returns the nearest businesses first, and only within the radius', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })

    // Four real places, chosen so their distances from central Kampala are
    // distinguishable: the centre itself, a neighbour ~2 km out, a satellite city
    // ~20 km out, and a lakeside town ~35 km out.
    const kampala = findLocation(ctx, 'city', 'Kampala')
    const namugongo = findLocation(ctx, 'town', 'Namugongo')
    const mukono = findLocation(ctx, 'city', 'Mukono')
    const entebbe = findLocation(ctx, 'town', 'Entebbe')

    await makePublished(ctx, admin, 'Kampala City Centre Hardware', kampala)
    await makePublished(ctx, admin, 'Namugongo Electricals', namugongo)
    await makePublished(ctx, admin, 'Mukono Solar Supplies', mukono)
    await makePublished(ctx, admin, 'Entebbe Lakeside Repairs', entebbe)

    const near = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/businesses?lat=${KAMPALA.lat}&lng=${KAMPALA.lng}&radiusKm=10&sort=distance`,
    })
    assert.equal(near.statusCode, 200, near.body)
    const payload = near.json()
    const names = payload.data.map((item) => item.name)

    // Two businesses are within 10 km: the centre and its neighbour. The other
    // two are a city and a town further than that.
    assert.equal(payload.data.length, 2, names.join(', '))
    assert.equal(names[0], 'Kampala City Centre Hardware', 'nearest must come first')
    assert.equal(names[1], 'Namugongo Electricals')

    // The distances are attached and ordered, not just the order.
    assert.equal(payload.data[0].distanceKm, 0)
    assert.ok(payload.data[1].distanceKm > 1 && payload.data[1].distanceKm < 3, String(payload.data[1].distanceKm))
    for (let i = 1; i < payload.data.length; i += 1) {
      assert.ok(
        payload.data[i].distanceKm >= payload.data[i - 1].distanceKm,
        'results must be ordered nearest first',
      )
    }

    // The page says where the search was centred and how wide it was, so a page
    // that rendered it can say "within 10 km" without keeping its own copy.
    assert.deepEqual(payload.meta.geo, { lat: KAMPALA.lat, lng: KAMPALA.lng, radiusKm: 10 })
    assert.equal(payload.meta.total, 2)

    // Widening the radius reaches the satellite city and the town, still nearest
    // first — the ordering is a property of the centre, not of the radius.
    const wide = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/businesses?lat=${KAMPALA.lat}&lng=${KAMPALA.lng}&radiusKm=40&sort=distance`,
    })
    assert.equal(wide.statusCode, 200, wide.body)
    const wideNames = wide.json().data.map((item) => item.name)
    assert.equal(wideNames.length, 4, wideNames.join(', '))
    assert.deepEqual(wideNames, [
      'Kampala City Centre Hardware',
      'Namugongo Electricals',
      'Mukono Solar Supplies',
      'Entebbe Lakeside Repairs',
    ])

    // Without a centre, nothing is measured and nothing carries a distance —
    // the ordinary listing is unchanged by the feature.
    const plain = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
    assert.equal(plain.statusCode, 200, plain.body)
    assert.equal(plain.json().data.length, 4)
    for (const item of plain.json().data) {
      assert.equal(item.distanceKm, undefined)
    }
    assert.equal(plain.json().meta.geo, undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('half a location is refused, and so is a radius the platform does not serve', async () => {
  const ctx = await freshServer()
  try {
    const half = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/businesses?lat=0.3476',
    })
    assert.equal(half.statusCode, 400, half.body)
    assert.match(half.json().error.message, /latitude and a longitude/)

    const tooWide = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/businesses?lat=0.3476&lng=32.5825&radiusKm=900',
    })
    assert.equal(tooWide.statusCode, 400, tooWide.body)

    const badLatitude = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/businesses?lat=91&lng=32.5825',
    })
    assert.equal(badLatitude.statusCode, 400, badLatitude.body)
  } finally {
    await ctx.cleanup()
  }
})
