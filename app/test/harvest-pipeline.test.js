import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { harvest } from '../src/harvest/index.js'

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'harvest')

function freshApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-harvest-pipe-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'harvest.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { app, config }
}

function tempOutDir() {
  return path.join(
    os.tmpdir(),
    `kip-harvest-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

const FIXTURE_FIELDS = {
  name: [{ jsonld: 'name' }, { og: 'og:title' }, { selector: 'h1' }],
  category: [{ value: 'services/beauty-and-personal-care/barbering' }],
  location: [{ value: 'Kampala/Nakawa Division' }],
  phone: [
    { selector: "a[href^='tel:']", attr: 'href', stripPrefix: 'tel:' },
    { selector: "a[href^='tel:']" },
  ],
  email: [{ selector: "a[href^='mailto:']", attr: 'href', stripPrefix: 'mailto:' }],
  address: [{ selector: '.address' }],
  services: [{ selector: '.services span', all: true }],
  external_ref: [{ page: 'path' }],
}

function registerFixtureSource(app, key = 'fixture-harvest') {
  return app.catalogue.createSource({
    key,
    name: 'Fixture Harvest',
    type: 'web',
    trustLevel: 'unverified',
  })
}

test('harvest extracts records from a fixture plan and produces an accountable run', async (t) => {
  const { app } = freshApp(t)
  const src = registerFixtureSource(app)

  const result = await harvest(
    app,
    {
      sourceKey: 'fixture-harvest',
      baseUrl: 'https://fixture.example',
      batchRef: 'test-2026-10',
      pages: [
        { url: 'https://fixture.example/studio', mirror: 'studio.html' },
        { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
      ],
      fields: FIXTURE_FIELDS,
    },
    { fromDir: FIXTURES, outputDir: tempOutDir(), actor: { id: null, role: 'admin' } },
  )

  assert.ok(result.import)
  assert.ok(result.import.run)
  assert.equal(result.import.summary.created, 2)
  assert.equal(result.import.summary.skipped, 0)
  assert.equal(result.import.summary.failed, 0)
  assert.ok(result.files.csv)
  assert.ok(result.files.manifest)

  const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8'))
  assert.ok(manifest.csvSha256)
  assert.equal(manifest.totals.records, 2)
  assert.equal(manifest.pages.length, 2)

  // The two records are real, attributed to the source, and still private.
  const studio = app.businesses.findBySlug('nakawa-hair-studio')
  assert.ok(studio)
  assert.equal(studio.catalogueSourceId, src.id)
  assert.equal(studio.verificationState, 'pending_review')
})

test('every record carries the page it came from as evidence', async (t) => {
  const { app } = freshApp(t)
  const src = registerFixtureSource(app)

  const result = await harvest(
    app,
    {
      sourceKey: 'fixture-harvest',
      batchRef: 'test-2026-10',
      pages: [
        { url: 'https://fixture.example/studio', mirror: 'studio.html' },
        { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
      ],
      fields: FIXTURE_FIELDS,
    },
    { fromDir: FIXTURES, outputDir: tempOutDir() },
  )

  const provenance = app.catalogue.provenanceForSource(src.id, { limit: 10 })
  assert.ok(Array.isArray(provenance))
  assert.equal(provenance.length, 2)
  const evidence = provenance.map((p) => p.evidence).sort()
  assert.deepEqual(evidence, [
    'https://fixture.example/barbers',
    'https://fixture.example/studio',
  ])
})

test('the manifest hashes the exact CSV bytes it shipped', async (t) => {
  const { app } = freshApp(t)
  registerFixtureSource(app)

  const result = await harvest(
    app,
    {
      sourceKey: 'fixture-harvest',
      batchRef: 't2',
      pages: [
        { url: 'https://fixture.example/studio', mirror: 'studio.html' },
        { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
      ],
      fields: FIXTURE_FIELDS,
    },
    { fromDir: FIXTURES, outputDir: tempOutDir() },
  )

  const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8'))
  const csv = fs.readFileSync(result.files.csv)
  assert.equal(manifest.csvSha256, createHash('sha256').update(csv).digest('hex'))
  assert.equal(manifest.csvBytes, csv.length)
})

test('replaying a harvest batch is idempotent: creates nothing on the second run', async (t) => {
  const { app } = freshApp(t)
  registerFixtureSource(app)

  const plan = {
    sourceKey: 'fixture-harvest',
    batchRef: 't3',
    pages: [
      { url: 'https://fixture.example/studio', mirror: 'studio.html' },
      { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
    ],
    fields: FIXTURE_FIELDS,
  }

  const first = await harvest(app, plan, { fromDir: FIXTURES, outputDir: tempOutDir() })
  assert.equal(first.import.summary.created, 2)

  const second = await harvest(app, plan, { fromDir: FIXTURES, outputDir: tempOutDir() })
  assert.equal(second.import.summary.created, 0)
  assert.equal(second.import.summary.skipped, 2)
  assert.equal(second.import.summary.failed, 0)
})

test('a page that 404s fails loudly, before anything is written', async (t) => {
  const { app } = freshApp(t)
  const src = registerFixtureSource(app, 'fixture-harvest-404')
  const plan = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'missing-plan.json'), 'utf8'))

  await assert.rejects(
    () => harvest(app, plan, { fromDir: FIXTURES, outputDir: tempOutDir() }),
    /not found|returned 404/i,
  )
  assert.equal(app.catalogue.provenanceForSource(src.id).length, 0)
})

test('a page that yields no usable record is an error, not an empty success', async (t) => {
  const { app } = freshApp(t)
  const src = registerFixtureSource(app, 'fixture-harvest-empty')
  const plan = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'empty-plan.json'), 'utf8'))

  await assert.rejects(
    () => harvest(app, plan, { fromDir: FIXTURES, outputDir: tempOutDir() }),
    /missing name|produced no records/i,
  )
  assert.equal(app.catalogue.provenanceForSource(src.id).length, 0)
})

test('a dry run reports what it would do and writes nothing', async (t) => {
  const { app } = freshApp(t)
  const src = registerFixtureSource(app)
  const outDir = tempOutDir()

  const result = await harvest(
    app,
    {
      sourceKey: 'fixture-harvest',
      batchRef: 't4',
      pages: [
        { url: 'https://fixture.example/studio', mirror: 'studio.html' },
        { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
      ],
      fields: FIXTURE_FIELDS,
    },
    { fromDir: FIXTURES, outputDir: outDir, dryRun: true },
  )

  assert.equal(result.dryRun, true)
  assert.equal(result.rows.length, 2)
  assert.equal(result.import, null)
  assert.equal(fs.existsSync(outDir), false)
  assert.equal(app.catalogue.provenanceForSource(src.id).length, 0)
})

test('a live run can archive the bytes it read, and those bytes replay offline', async (t) => {
  const { app } = freshApp(t)
  registerFixtureSource(app)

  const bodies = {
    'https://fixture.example/studio': fs.readFileSync(path.join(FIXTURES, 'studio.html'), 'utf8'),
    'https://fixture.example/barbers': fs.readFileSync(path.join(FIXTURES, 'barbers.html'), 'utf8'),
  }
  const liveTransport = {
    async read(page) {
      return {
        status: 200,
        body: bodies[page.url],
        finalUrl: page.url,
        fetchedAt: new Date().toISOString(),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    },
  }

  const plan = {
    sourceKey: 'fixture-harvest',
    batchRef: 'live-1',
    // No `mirror` fields: this is a live plan. The archive supplies them.
    pages: [{ url: 'https://fixture.example/studio' }, { url: 'https://fixture.example/barbers' }],
    fields: FIXTURE_FIELDS,
  }

  const mirrorDir = tempOutDir()
  const live = await harvest(app, plan, {
    transport: liveTransport,
    outputDir: tempOutDir(),
    mirrorOut: mirrorDir,
  })
  assert.equal(live.import.summary.created, 2)
  assert.equal(live.archiveRoot, path.resolve(mirrorDir))

  // Every page the manifest describes was written, and hashes to what it claims.
  const manifest = JSON.parse(fs.readFileSync(live.files.manifest, 'utf8'))
  for (const page of manifest.pages) {
    assert.ok(page.archived, 'each page records where it was archived')
    const file = path.join(mirrorDir, page.archived)
    assert.ok(fs.existsSync(file), `${page.archived} should exist in the archive`)
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), page.sha256)
  }

  // Replaying the same plan from the archive yields the same batch, no network.
  const replay = await harvest(app, plan, { fromDir: mirrorDir, outputDir: tempOutDir() })
  assert.equal(replay.import.summary.created, 0)
  assert.equal(replay.import.summary.skipped, 2)
  assert.equal(
    fs.readFileSync(replay.files.csv, 'utf8'),
    fs.readFileSync(live.files.csv, 'utf8'),
  )
})
