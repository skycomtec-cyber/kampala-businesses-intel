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
import { parseAsk, ASK_INTENTS } from '../src/core/ask.js'

/**
 * Ask Kampala.
 *
 * The parser is asserted directly against `core/ask.js`, because "how did it
 * read the question" is a claim the endpoint makes about itself and it should be
 * checkable without a database. The route is exercised too, because a parser that
 * resolves "Device Repair" and "Kampala" correctly is worth nothing if the
 * endpoint cannot turn that into an answer.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CATEGORIES = [
  { id: 'c-device', name: 'Device Repair', slug: 'device-repair' },
  { id: 'c-laptop', name: 'Laptop Repair', slug: 'laptop-repair' },
]
const LOCATIONS = [
  { id: 'l-kla', name: 'Kampala', slug: 'kampala', kind: 'city' },
  { id: 'l-div', name: 'Kampala Central Division', slug: 'kampala-central-division', kind: 'division' },
]

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-ask-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'ask.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })

  // One published business to answer questions about. Created into the queue the
  // way every record is, then walked to approved, because that is the only path to
  // a listing the public can find.
  const category = app.categories.all().find((row) => row.name === 'Device Repair')
  const district = app.locations.byKind('district').find((row) => row.name === 'Kampala District')
  const business = app.businesses.create({
    name: 'Laptop Repair Hub',
    categoryId: category.id,
    locationId: district.id,
    status: 'active',
  })
  app.businesses.review(business.id, { action: 'verify' })
  app.businesses.review(business.id, { action: 'approve' })

  return {
    app,
    server,
    category,
    district,
    business,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function ask(ctx, q) {
  const response = await ctx.server.inject({ method: 'GET', url: `/api/v1/ask?q=${encodeURIComponent(q)}` })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('a "how many" question is read as a count and anything else as a find', () => {
  assert.deepEqual([...ASK_INTENTS], ['find', 'count'])
  assert.equal(parseAsk('how many phone repairers are there').intent, 'count')
  assert.equal(parseAsk('count the electronics recyclers').intent, 'count')
  assert.equal(parseAsk('where can I repair a laptop').intent, 'find')
})

test('a question resolves a category and a place and leaves the rest as text', () => {
  const plan = parseAsk('how many laptop repair businesses in Kampala Central Division', {
    categories: CATEGORIES,
    locations: LOCATIONS,
  })
  assert.equal(plan.intent, 'count')
  assert.equal(plan.category.name, 'Laptop Repair')
  // The division is inside the city, so the longer name is the one that was meant.
  assert.equal(plan.location.name, 'Kampala Central Division')
  assert.equal(plan.matched.categoryPhrase, 'laptop repair')
  assert.equal(plan.matched.locationPhrase, 'kampala central division')
  assert.equal(plan.text, '', 'the recognised names and the question scaffolding leave nothing behind')
})

test('a word it does not recognise is kept as free text rather than dropped', () => {
  const plan = parseAsk('where can I find a boda mechanic in Ntinda', {
    categories: CATEGORIES,
    locations: LOCATIONS,
  })
  assert.equal(plan.intent, 'find')
  assert.equal(plan.category, null)
  assert.equal(plan.location, null, 'Ntinda is not in this vocabulary')
  assert.equal(plan.text, 'boda mechanic ntinda', 'the unknown place narrows the search instead of vanishing')
})

test('the endpoint answers a count question with a number and an explanation', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const body = await ask(ctx, 'how many device repair businesses are in Kampala District')
  assert.equal(body.meta.intent, 'count')
  assert.equal(body.meta.total, 1)
  assert.deepEqual(body.data, [])
  assert.equal(body.meta.understood.category.name, 'Device Repair')
  assert.equal(body.meta.understood.location.name, 'Kampala District')
  assert.match(body.meta.answer, /1 listing.*Device Repair.*Kampala District/)
})

test('the endpoint answers an open question with matching businesses', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const body = await ask(ctx, 'laptop repair in Kampala District')
  assert.equal(body.meta.intent, 'find')
  assert.equal(body.meta.understood.text, 'laptop repair')
  assert.equal(body.meta.understood.category, null, 'there is no "laptop repair" category; it is free text')
  assert.ok(body.meta.total >= 1, body.meta.answer)
  assert.ok(body.data.some((item) => item.title === 'Laptop Repair Hub'), JSON.stringify(body.data))
})

test('a question with no match says so rather than returning an unexplained empty list', async (t) => {
  const ctx = await freshServer()
  t.after(() => ctx.cleanup())

  const body = await ask(ctx, 'underwater basket weaving in Kampala District')
  assert.equal(body.meta.total, 0)
  assert.match(body.meta.answer, /^Nothing matched/)
})
