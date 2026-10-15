import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { importBusinessesFromCsv } from '../src/import/index.js'

/**
 * The harvest run: what a population import is accountable for.
 *
 * Phase 2 made one record accountable. This is the same promise made about a
 * file. An operator pointing the directory at a real source — a spreadsheet of
 * businesses walked in one market, a directory scraped from a site — needs three
 * answers afterwards: what did this file actually do, can I run it again without
 * doubling the directory, and which of the businesses this source used to
 * describe did the file not mention this time. The last one is a report and
 * nothing more, and the test that matters most is that reading it changes
 * nothing: a source that omitted a row must never be able to unpublish a listing
 * by being incomplete.
 *
 * The list of tests is the acceptance list for the phase, one promise each:
 *
 *   - a run records what the file did
 *   - replaying a file is idempotent, provenance included
 *   - a file attributed to a source the catalogue does not know is refused
 *   - a retired source is refused too
 *   - a file import is not public, whatever the file says
 *   - reconciliation reports stale references and mutates nothing
 */

const BARBERING = 'services/beauty-and-personal-care/barbering'
const UNKNOWN_CATEGORY = 'services/no-such-trade/nothing'
const COLUMNS = ['name', 'category', 'location', 'phone', 'external_ref']

const SOURCE = {
  name: 'Nakawa Field Survey',
  type: 'manual',
  trustLevel: 'unverified',
  description: 'Businesses recorded on foot by a survey team.',
}

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-harvest-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'harvest.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  return {
    app,
    cleanup() {
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function csvFile(rows, columns = COLUMNS) {
  const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((column) => quote(row[column] ?? '')).join(','))
  return lines.join('\n') + '\n'
}

function row(name, reference, phonePrefix = '0772') {
  return {
    name,
    category: BARBERING,
    location: 'Kampala/Nakawa Division',
    phone: `${phonePrefix} 111 222`,
    external_ref: reference,
  }
}

test('a harvest run records what the file did', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(SOURCE)
  const file = csvFile([
    row('Nakawa Hair Studio', 'NFS-001', '0772'),
    row('Kintu Road Barbers', 'NFS-002', '0773'),
    // A category the reference data does not have: one failed row, which is the
    // case a run most needs to be able to describe.
    {
      name: 'Mystery Trade',
      category: UNKNOWN_CATEGORY,
      location: 'Kampala/Nakawa Division',
      phone: '0774 111 222',
      external_ref: 'NFS-003',
    },
  ])

  const { summary, run, source: attributed } = importBusinessesFromCsv(ctx.app, file, {
    sourceKey: source.key,
    batchRef: '2026-10',
    filename: 'nakawa-october.csv',
    actor: { id: null, role: 'admin' },
  })

  assert.equal(attributed.key, source.key)
  assert.equal(summary.created, 2)
  assert.equal(summary.failed, 1)

  // The run is stored, not merely returned, and it carries the file's identity.
  assert.ok(run, 'the import produced a run')
  assert.equal(run.status, 'completed')
  assert.equal(run.sourceId, source.id)
  assert.equal(run.batchRef, '2026-10')
  assert.equal(run.filename, 'nakawa-october.csv')
  assert.match(run.contentSha256, /^[0-9a-f]{64}$/)
  assert.equal(run.total, 3)
  assert.equal(run.createdCount, 2)
  assert.equal(run.skippedCount, 0)
  assert.equal(run.failedCount, 1)
  assert.notEqual(run.finishedAt, null)

  const stored = ctx.app.catalogue.findRunById(run.id)
  assert.deepEqual(stored, run)
  assert.deepEqual(
    ctx.app.catalogue.listRuns().items.map((entry) => entry.id),
    [run.id],
  )

  // Every created listing carries its source in the record and its provenance
  // points at the run, which is what makes the run answerable months later.
  const studio = ctx.app.businesses.findBySlug('nakawa-hair-studio')
  assert.equal(studio.catalogueSourceId, source.id)
  const provenance = ctx.app.catalogue.provenanceFor(studio.id)
  assert.equal(provenance.length, 1)
  assert.equal(provenance[0].sourceId, source.id)
  assert.equal(provenance[0].runId, run.id)
  assert.equal(provenance[0].externalRef, 'NFS-001')
})

test('replaying a file changes no provenance and records a second run', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(SOURCE)
  const file = csvFile([row('Nakawa Hair Studio', 'NFS-001', '0772'), row('Kintu Road Barbers', 'NFS-002', '0773')])

  const first = importBusinessesFromCsv(ctx.app, file, { sourceKey: source.key })
  const second = importBusinessesFromCsv(ctx.app, file, { sourceKey: source.key })

  assert.equal(first.summary.created, 2)
  assert.equal(second.summary.created, 0)
  assert.equal(second.summary.skipped, 2)

  // Two runs, but still two businesses and still one provenance row each: the
  // replay updated the claim about where each record came from rather than
  // stacking a second one.
  assert.equal(ctx.app.businesses.all().length, 2)
  assert.equal(ctx.app.catalogue.listRuns().total, 2)
  assert.equal(ctx.app.catalogue.provenanceForSource(source.id).length, 2)

  const studio = ctx.app.businesses.findBySlug('nakawa-hair-studio')
  assert.equal(ctx.app.catalogue.provenanceFor(studio.id).length, 1)
  // The row now points at the run that most recently saw it, which is what makes
  // "the newest run did not mention this reference" a meaningful question.
  assert.equal(ctx.app.catalogue.provenanceFor(studio.id)[0].runId, second.run.id)
})

test('a file attributed to an unknown source is refused before anything is read', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  assert.throws(
    () => importBusinessesFromCsv(ctx.app, csvFile([row('Nakawa Hair Studio', 'NFS-001')]), {
      sourceKey: 'no-such-source',
    }),
    /Catalogue source not found/,
  )
  assert.equal(ctx.app.businesses.all().length, 0, 'nothing was written')
  assert.equal(ctx.app.catalogue.listRuns().total, 0, 'no run was opened')
})

test('a retired source cannot be fed new records', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(SOURCE)
  ctx.app.catalogue.retireSource(source.id)

  assert.throws(
    () => importBusinessesFromCsv(ctx.app, csvFile([row('Nakawa Hair Studio', 'NFS-001')]), {
      sourceKey: source.key,
    }),
    /is retired/,
  )
  assert.equal(ctx.app.businesses.all().length, 0)
  assert.equal(ctx.app.catalogue.listRuns().total, 0)
})

test('a file import is not public until a reviewer makes it so', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(SOURCE)
  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([row('Nakawa Hair Studio', 'NFS-001'), row('Kintu Road Barbers', 'NFS-002', '0773')]),
    { sourceKey: source.key },
  )
  assert.equal(summary.created, 2)

  // A source can say a business exists; it cannot say this platform has checked
  // it. So the file populates the directory and nothing else: no public search
  // result and no published count, whatever the file contains.
  assert.equal(ctx.app.searchIndex.search({ query: 'hair studio' }).total, 0)
  assert.equal(ctx.app.businesses.countPublished(), 0)
})

test('reconciliation reports the references a run did not repeat, and changes nothing', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(SOURCE)
  const first = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      row('Nakawa Hair Studio', 'NFS-001', '0772'),
      row('Kintu Road Barbers', 'NFS-002', '0773'),
      row('Nakawa Tailors', 'NFS-003', '0774'),
    ]),
    { sourceKey: source.key },
  )
  assert.equal(first.summary.created, 3)

  // The second file drops NFS-003. That is the whole scenario: the survey team
  // stopped at two shops this time.
  const second = importBusinessesFromCsv(
    ctx.app,
    csvFile([row('Nakawa Hair Studio', 'NFS-001', '0772'), row('Kintu Road Barbers', 'NFS-002', '0773')]),
    { sourceKey: source.key },
  )

  const report = second.reconciliation
  assert.ok(report, 'a run reports its reconciliation')
  assert.equal(report.staleCount, 1)
  assert.equal(report.stale[0].externalRef, 'NFS-003')
  assert.equal(report.stale[0].businessName, 'Nakawa Tailors')

  // And the report is read-only. The business still exists, its provenance still
  // points at the run that created it, and its state is untouched: a file that
  // omits a row is evidence the file changed, not evidence the business closed.
  const tailors = ctx.app.businesses.findBySlug('nakawa-tailors')
  assert.ok(tailors, 'the omitted business is still in the directory')
  assert.equal(tailors.verificationState, 'pending_review')
  const provenance = ctx.app.catalogue.provenanceFor(tailors.id)
  assert.equal(provenance.length, 1)
  assert.equal(provenance[0].runId, first.run.id)

  // Asking again gives the same answer and still changes nothing.
  const again = ctx.app.catalogue.reconcileRun(second.run.id)
  assert.equal(again.staleCount, 1)
  assert.equal(ctx.app.businesses.all().length, 3)
  assert.equal(ctx.app.catalogue.provenanceForSource(source.id).length, 3)
})
