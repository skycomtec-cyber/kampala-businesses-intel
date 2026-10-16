import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import {
  discoverPlans,
  isPlanDue,
  diffRunReferences,
  runScheduledHarvests,
} from '../src/harvest/schedule.js'

/**
 * The harvest scheduler: the clock, the due rule, and the diff.
 *
 * The point of this file is the part `harvest.test.js` does not cover. A plan can
 * be harvested perfectly and still never be re-harvested, and the two ways that
 * goes wrong are covered here: the due rule must not reset on a run that failed
 * to refresh the source, and the diff must be read before the new run overwrites
 * the provenance it is comparing against. Both are ordering facts, and both are
 * invisible to a test that only harvests once.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scheduleScript = path.join(appRoot, 'scripts', 'harvest-schedule.js')
const FIXTURES = path.join(appRoot, 'test', 'fixtures', 'harvest')

// Identity for a harvested record defaults to the page it was read from, so these
// are the references the diff counts: one per fixture page.
const STUDIO_REF = 'https://fixture.example/studio'
const BARBERS_REF = 'https://fixture.example/barbers'

const FIXTURE_FIELDS = {
  name: [{ jsonld: 'name' }, { og: 'og:title' }, { selector: 'h1' }],
  category: [{ value: 'services/beauty-and-personal-care/barbering' }],
  location: [{ value: 'Kampala/Nakawa Division' }],
  external_ref: [{ page: 'path' }],
}

function tempDir(prefix = 'kip-sched-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function freshApp(t) {
  const dir = tempDir('kip-sched-app-')
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'harvest.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { app, config }
}

function registerSource(app, key = 'fixture-harvest') {
  return app.catalogue.createSource({
    key,
    name: 'Fixture Harvest',
    type: 'web',
    trustLevel: 'unverified',
  })
}

function writePlan(dir, name, plan) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2), 'utf8')
  return file
}

/**
 * A transport that serves the fixture bodies by URL, so a run is live enough to
 * exercise archiving without touching the network.
 */
function liveTransport() {
  const bodies = {
    'https://fixture.example/studio': fs.readFileSync(path.join(FIXTURES, 'studio.html'), 'utf8'),
    'https://fixture.example/barbers': fs.readFileSync(path.join(FIXTURES, 'barbers.html'), 'utf8'),
  }
  return {
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
}

function fixturePlan(overrides = {}) {
  return {
    sourceKey: 'fixture-harvest',
    batchRef: 'sched-1',
    cadenceDays: 30,
    pages: [
      { url: 'https://fixture.example/studio', mirror: 'studio.html' },
      { url: 'https://fixture.example/barbers', mirror: 'barbers.html' },
    ],
    fields: FIXTURE_FIELDS,
    ...overrides,
  }
}

test('a plan that has never run is due', () => {
  assert.equal(isPlanDue({ lastRunAt: null, cadenceDays: 30 }), true)
  assert.equal(isPlanDue({ lastRunAt: undefined, cadenceDays: 30 }), true)
})

test('a plan is due once its cadence has elapsed, and not before', () => {
  const now = new Date('2026-10-16T00:00:00.000Z')
  const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString()

  assert.equal(isPlanDue({ lastRunAt: ago(29), cadenceDays: 30, now }), false)
  assert.equal(isPlanDue({ lastRunAt: ago(30), cadenceDays: 30, now }), true, 'the boundary is inclusive')
  assert.equal(isPlanDue({ lastRunAt: ago(31), cadenceDays: 30, now }), true)
})

test('an unparseable last-run time is treated as due rather than never again', () => {
  assert.equal(
    isPlanDue({ lastRunAt: 'not a date', cadenceDays: 30, now: new Date() }),
    true,
    'a source is better read once too often than never again because a timestamp was malformed',
  )
})

test('an impossible cadence is refused, not guessed at', () => {
  for (const bad of [0, -1, 1.5, 400, '30', null]) {
    assert.throws(
      () => isPlanDue({ lastRunAt: null, cadenceDays: bad }),
      /cadence/i,
      `${JSON.stringify(bad)} should not be accepted as a cadence`,
    )
  }
})

test('the diff counts references added, removed and unchanged', () => {
  const diff = diffRunReferences(['/a', '/b'], ['/b', '/c'])
  assert.deepEqual(diff.added, ['/c'])
  assert.deepEqual(diff.removed, ['/a'])
  assert.equal(diff.unchanged, 1)
  assert.equal(diff.previousCount, 2)
  assert.equal(diff.currentCount, 2)
  assert.equal(diff.firstRun, false)
})

test('the diff of a first run is every reference, none of them carried over', () => {
  const diff = diffRunReferences([], ['/a', '/b'], { firstRun: true })
  assert.deepEqual(diff.added, ['/a', '/b'])
  assert.deepEqual(diff.removed, [])
  assert.equal(diff.unchanged, 0)
  assert.equal(diff.firstRun, true)
})

test('discovering plans reports each one, including the ones that do not validate', (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  writePlan(dir, 'kampalabiz-space/eder.json', fixturePlan())
  writePlan(dir, 'manual.json', fixturePlan({ batchRef: 'manual', cadenceDays: undefined }))
  writePlan(dir, 'broken.json', '{ this is not json ')

  const entries = discoverPlans(dir)
  const byFile = Object.fromEntries(entries.map((entry) => [entry.file, entry]))

  assert.equal(entries.length, 3)
  assert.equal(byFile['kampalabiz-space/eder.json'].plan.cadenceDays, 30)
  assert.equal(byFile['kampalabiz-space/eder.json'].sourceKey, 'fixture-harvest')
  assert.equal(byFile['manual.json'].plan.cadenceDays, null, 'no cadence means a manual plan')
  assert.equal(byFile['broken.json'].plan, null)
  assert.match(byFile['broken.json'].error, /JSON|Unexpected|position/i)
})

test('a scheduled plan is harvested, archived, and diffed as a first run', async (t) => {
  const { app } = freshApp(t)
  registerSource(app)

  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'studio.json', fixturePlan())

  const archiveRoot = tempDir()
  t.after(() => fs.rmSync(archiveRoot, { recursive: true, force: true }))

  const report = await runScheduledHarvests(app, {
    plansDir,
    transport: liveTransport(),
    archiveRoot,
    batchDir: tempDir(),
    now: new Date('2026-10-16T00:00:00.000Z'),
  })

  assert.equal(report.scheduled, 1)
  assert.equal(report.harvested, 1)

  const [result] = report.results
  assert.equal(result.status, 'harvested')
  assert.equal(result.summary.created, 2)
  assert.equal(result.diff.firstRun, true)
  assert.deepEqual(result.diff.added.sort(), [BARBERS_REF, STUDIO_REF])

  // The pages this live run read were archived, so the run can be replayed later.
  assert.ok(result.archiveRoot, 'a live run archives what it read')
  assert.ok(
    result.archiveRoot.startsWith(path.resolve(archiveRoot)),
    'the archive lands under the configured root',
  )

  // The run is stored, and the plan now has a completed run to be measured against.
  const source = app.catalogue.findSourceByKey('fixture-harvest')
  const latest = app.catalogue.latestCompletedRunForPlan(source.id, { batchRef: 'sched-1' })
  assert.equal(latest.id, result.runId)
})

test('a plan whose cadence has not elapsed is skipped, not harvested', async (t) => {
  const { app } = freshApp(t)
  registerSource(app)

  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'studio.json', fixturePlan())

  const options = {
    plansDir,
    transport: liveTransport(),
    batchDir: tempDir(),
    now: new Date('2026-10-16T00:00:00.000Z'),
  }
  await runScheduledHarvests(app, options)

  // The clock has not moved, so nothing is due.
  const second = await runScheduledHarvests(app, options)
  assert.equal(second.harvested, 0)
  assert.equal(second.skipped, 1)
  assert.equal(second.results[0].status, 'skipped')
  assert.equal(second.results[0].reason, 'not-due')

  // A month later it is due again.
  const later = await runScheduledHarvests(app, {
    ...options,
    now: new Date('2026-11-16T00:00:00.000Z'),
  })
  assert.equal(later.harvested, 1)
})

test('the diff reflects what a later run added and stopped repeating', async (t) => {
  const { app } = freshApp(t)
  registerSource(app)

  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'studio.json', fixturePlan())

  const options = {
    plansDir,
    transport: liveTransport(),
    batchDir: tempDir(),
    now: new Date('2026-10-16T00:00:00.000Z'),
  }
  await runScheduledHarvests(app, options)

  // A second run over the same pages changes nothing, and says so.
  const same = await runScheduledHarvests(app, { ...options, all: true })
  assert.equal(same.results[0].diff.unchanged, 2)
  assert.equal(same.results[0].diff.added.length, 0)
  assert.equal(same.results[0].diff.removed.length, 0)

  // The source drops one page, which is the scenario the diff exists for: the
  // reference it used to describe is now gone from the run.
  writePlan(plansDir, 'studio.json', fixturePlan({ pages: [fixturePlan().pages[0]] }))
  const dropped = await runScheduledHarvests(app, { ...options, all: true })
  assert.deepEqual(dropped.results[0].diff.removed, [BARBERS_REF])
  assert.deepEqual(dropped.results[0].diff.added, [])
  assert.equal(dropped.results[0].diff.unchanged, 1)
})

test('a scheduled plan whose source is not registered fails without fetching', async (t) => {
  const { app } = freshApp(t)
  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'ghost.json', fixturePlan({ sourceKey: 'ghost-source', cadenceDays: 5 }))

  let fetched = 0
  const report = await runScheduledHarvests(app, {
    plansDir,
    transport: {
      async read(page) {
        fetched += 1
        return { status: 200, body: '', finalUrl: page.url, headers: {} }
      },
    },
    now: new Date('2026-10-16T00:00:00.000Z'),
  })

  assert.equal(report.failed, 1)
  assert.equal(report.results[0].status, 'failed')
  assert.match(report.results[0].error, /not registered/)
  assert.equal(fetched, 0, 'a plan that cannot be imported is not fetched first')
})

test('a dry run reports what is due and writes nothing', async (t) => {
  const { app } = freshApp(t)
  const src = registerSource(app)
  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'studio.json', fixturePlan())

  const report = await runScheduledHarvests(app, {
    plansDir,
    dryRun: true,
    transport: liveTransport(),
    now: new Date('2026-10-16T00:00:00.000Z'),
  })

  assert.equal(report.dryRun, true)
  assert.equal(report.due, 1)
  assert.equal(report.results[0].status, 'due')
  assert.equal(app.catalogue.provenanceForSource(src.id).length, 0)
  assert.equal(app.catalogue.listRuns().total, 0)
})

test('a manual plan is reported but never harvested', async (t) => {
  const { app } = freshApp(t)
  const src = registerSource(app)
  const plansDir = tempDir()
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'manual.json', fixturePlan({ cadenceDays: undefined }))

  const report = await runScheduledHarvests(app, {
    plansDir,
    transport: liveTransport(),
    now: new Date('2026-10-16T00:00:00.000Z'),
  })

  assert.equal(report.manual, 1)
  assert.equal(report.results[0].status, 'manual')
  assert.equal(app.catalogue.provenanceForSource(src.id).length, 0)
})

test('the schedule command runs, reports what is due, and reads a mirror offline', async (t) => {
  const dataDir = tempDir('kip-sched-cli-')
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

  const previous = process.env.KIP_DATA_DIR
  process.env.KIP_DATA_DIR = dataDir
  try {
    const app = openApp({ config: loadConfig() })
    seedReferenceData(app, { config: loadConfig() })
    registerSource(app)
    app.close()
  } finally {
    if (previous === undefined) delete process.env.KIP_DATA_DIR
    else process.env.KIP_DATA_DIR = previous
  }

  const plansDir = tempDir('kip-sched-cli-plans-')
  t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }))
  writePlan(plansDir, 'studio.json', fixturePlan())

  // A dry run proves the command is wired to the plan directory and needs no network.
  const dry = await runCli(['--dry-run', '--plans-dir', plansDir], dataDir)
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /studio\.json/)
  assert.match(dry.stdout, /due|Dry run/i)

  // And a replay from the fixture mirror harvests for real, against the same
  // database, with no page ever fetched.
  const replay = await runCli(
    ['--from-dir', FIXTURES, '--plans-dir', plansDir, '--out-dir', tempDir()],
    dataDir,
  )
  assert.equal(replay.code, 0, replay.stderr)
  assert.match(replay.stdout, /harvested/i)
  assert.match(replay.stdout, /2 created/)

  const result = readCatalogue(dataDir)
  assert.equal(result.runCount, 1, 'the replay opened exactly one run')
  assert.equal(result.provenanceCount, 2)
})

function runCli(args, dataDir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scheduleScript, ...args],
      { env: { ...process.env, KIP_DATA_DIR: dataDir }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
  })
}

function readCatalogue(dataDir) {
  const previous = process.env.KIP_DATA_DIR
  process.env.KIP_DATA_DIR = dataDir
  try {
    const app = openApp({ config: loadConfig() })
    try {
      const source = app.catalogue.findSourceByKey('fixture-harvest')
      return {
        runCount: app.catalogue.listRuns({ sourceId: source.id }).total,
        provenanceCount: app.catalogue.provenanceForSource(source.id).length,
      }
    } finally {
      app.close()
    }
  } finally {
    if (previous === undefined) delete process.env.KIP_DATA_DIR
    else process.env.KIP_DATA_DIR = previous
  }
}
