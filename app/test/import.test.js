import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'
import { parseCsv, toRecords, splitList, normaliseHeader } from '../src/import/csv.js'
import { importBusinessesFromCsv } from '../src/import/index.js'
import { resolveCategory, resolveLocation, buildImportRow } from '../src/import/rows.js'

/**
 * The importer's tests.
 *
 * The behaviour locked down here is the behaviour an operator depends on and
 * cannot see from the outside: that a dry run writes nothing, that replaying the
 * same file changes nothing, that a bad row does not take the good ones with it,
 * and that a location which cannot be resolved is reported rather than guessed.
 * The last one matters most. Every other feature of this platform reads the
 * directory and draws conclusions about where supply is, so a row quietly placed
 * in the wrong division is a defect that surfaces much later, somewhere else.
 */

const PASSWORD = 'Kampala-Reference-2026'
const BARBERING = 'services/beauty-and-personal-care/barbering'
const ACCOUNTING = 'services/professional-services/accounting-and-bookkeeping'
const COLUMNS = [
  'name',
  'category',
  'location',
  'phone',
  'email',
  'website',
  'address',
  'services',
  'skills',
]

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-import-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'import.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  return {
    app,
    config,
    cleanup() {
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Builds a csv file.
 *
 * A row is either a raw line, for the cases where reading the line is the
 * clearest statement of the test, or an object keyed by column name, so a row
 * that sets one unusual column does not depend on counting commas.
 */
function csvFile(rows, columns = COLUMNS) {
  const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)
  const lines = [columns.join(',')]
  for (const row of rows) {
    if (typeof row === 'string') {
      lines.push(row)
      continue
    }
    lines.push(columns.map((column) => quote(row[column] ?? '')).join(','))
  }
  return lines.join('\n') + '\n'
}

/**
 * Lookups by path rather than by slug.
 *
 * `findBySlug` only finds a node whose parent is the given one, and defaults to
 * no parent at all, so asking it for "barbering" returns nothing. Tests want the
 * node a spreadsheet would name, which is the whole path.
 */
function categoryAt(app, pathSlugs) {
  const row = app.categories.all().find((entry) => entry.pathSlugs === pathSlugs)
  assert.ok(row, `no category at ${pathSlugs}`)
  return row
}

function locationNamed(app, name) {
  const row = app.locations.list({ limit: 1000 }).items.find((entry) => entry.name === name)
  assert.ok(row, `no location named ${name}`)
  return row
}

test('the csv reader handles what spreadsheets actually contain', () => {
  const source =
    '﻿name,note\r\n' +
    '"Nakawa, Studio","says ""hello"""\r\n' +
    '"multi\nline",plain\r\n' +
    'bare,\r\n'

  const { cells, lineOf } = parseCsv(source)

  assert.deepEqual(cells[0], ['name', 'note'])
  assert.deepEqual(cells[1], ['Nakawa, Studio', 'says "hello"'])
  // The quoted newline means the third record is not on source line 3, and the
  // report has to be able to point the operator at it anyway.
  assert.deepEqual(cells[2], ['multi\nline', 'plain'])
  assert.equal(lineOf[2], 3, 'the record starts on the line its first cell starts on')
  assert.deepEqual(cells[3], ['bare', ''])
  assert.equal(lineOf[3], 5, 'a record after an embedded newline reports the right line')
})

test('the csv reader refuses a file it cannot parse rather than guessing', () => {
  assert.throws(() => parseCsv('name,note\n"unclosed,note\n'), /never closed/)
  assert.throws(() => parseCsv('name\nva"lue\n'), /only open a field at its start/)
})

test('headers are matched the way an operator would expect', () => {
  assert.equal(normaliseHeader('Phone Number'), 'phone_number')
  assert.equal(normaliseHeader('phoneNumber'), 'phone_number')
  assert.equal(normaliseHeader('  Email  '), 'email')

  const { records } = toRecords(parseCsv('Name,Phone Number\nKampala Kitchens,0772 000 111\n'), {
    required: ['name', 'phone_number'],
  })
  assert.deepEqual(records, [{ name: 'Kampala Kitchens', phone_number: '0772 000 111' }])
})

test('a missing required column is reported by name', () => {
  assert.throws(
    () => toRecords(parseCsv('name,location\nA,Kampala\n'), { required: ['name', 'category'] }),
    /missing the required column\(s\): category/,
  )
})

test('multi-value cells split on the separators people type', () => {
  assert.deepEqual(splitList('Hair cuts, Braiding; Beard trims | Shaves'), [
    'Hair cuts',
    'Braiding',
    'Beard trims',
    'Shaves',
  ])
  assert.deepEqual(splitList(''), [])
})

test('a category resolves by path slug, by unique name, and by id', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const byPath = resolveCategory(ctx.app, BARBERING)
  const byName = resolveCategory(ctx.app, 'Barbering')
  const byId = resolveCategory(ctx.app, byPath.id)

  assert.equal(byPath.id, byName.id)
  assert.equal(byPath.id, byId.id)
  assert.throws(() => resolveCategory(ctx.app, 'Not A Category'), /is not a category/)
})

test('a location resolves by full path, by trailing path, and by unique name', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const nakawa = resolveLocation(ctx.app, 'Uganda/Central Region/Kampala District/Kampala/Nakawa Division')
  const short = resolveLocation(ctx.app, 'Kampala/Nakawa Division')
  const bare = resolveLocation(ctx.app, 'Nakawa Division')

  assert.equal(nakawa.id, short.id)
  assert.equal(nakawa.id, bare.id)
  assert.throws(() => resolveLocation(ctx.app, 'Atlantis'), /is not a location/)
})

test('a bare location name that is ambiguous is refused, not guessed', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  // The reference dataset happens to have no repeated names. The point is what
  // happens when it does: an operator who writes "Kampala" has not said which
  // Kampala, so the row is reported rather than placed somewhere plausible.
  const other = ctx.app.locations.ensureByPath([
    'Uganda',
    'Central Region',
    'Wakiso District',
    { kind: 'city', name: 'Kampala' },
  ])
  assert.equal(other.kind, 'city')

  assert.throws(() => resolveLocation(ctx.app, 'Kampala'), /matches 2 locations/)
  // The path form still works, because that is unambiguous.
  assert.equal(
    resolveLocation(ctx.app, 'Kampala/Nakawa Division').name,
    'Nakawa Division',
  )
})

test('an unresolvable location fails the row instead of picking one', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const before = ctx.app.businesses.countActive()
  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile(['Some Shop,' + BARBERING + ',Atlantis,0772000111']),
  )

  assert.equal(summary.failed, 1)
  assert.equal(summary.created, 0)
  assert.equal(ctx.app.businesses.countActive(), before)
})

test('a path that only partly resolves is refused, not truncated', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  // "Uganda" is a real place, and "Atlantis" is not. Matching the part that
  // exists would file the listing in the whole country and read as a Kampala
  // supply signal in every rollup, so a partial path has to fail like any other
  // unresolved location.
  assert.throws(
    () => resolveLocation(ctx.app, 'Uganda/Atlantis'),
    /is not a location in the reference data/,
  )
  assert.throws(
    () => resolveLocation(ctx.app, 'Kampala/Nakawa Division/Atlantis/Nested'),
    /is not a location in the reference data/,
  )

  // The full path still works, which is what makes the refusal above meaningful
  // rather than a general inability to read a path.
  assert.equal(
    resolveLocation(ctx.app, 'Kampala/Nakawa Division').name,
    'Nakawa Division',
  )
})

test('a business has to be filed under a leaf category', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const branch = categoryAt(ctx.app, 'services/beauty-and-personal-care')

  // A listing on a branch is counted in the rollup for that branch and for every
  // ancestor, so one salon would read as supply in two trades at once.
  const { summary, rows, unresolved } = importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,services/beauty-and-personal-care,Kampala/Nakawa Division,0772111222`]),
  )

  assert.equal(summary.failed, 1)
  assert.match(rows[0].detail, /has child categories/)
  assert.equal(unresolved[0].type, 'category_branch')
  assert.equal(unresolved[0].parentId, branch.id)

  // And the same row passes once it names the leaf, which is the point of
  // reporting the branch rather than refusing the file.
  const fixed = importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772111222`]),
  )
  assert.equal(fixed.summary.created, 1)
})

test('missing places are grouped into one report instead of one per row', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  // Four rows, two unknown wards, one of them named three times. A field survey
  // of an area nobody has mapped fails on a handful of places, not four hundred
  // different ones, and the operator should have to add two.
  const file = csvFile([
    `Nakawa Kiosk,${BARBERING},Kampala/Nakawa Division/Nakawa Central,0772 111 222`,
    `Nakawa Pharmacy,${BARBERING},Kampala/Nakawa Division/Nakawa Central,0772 333 444`,
    `Kireka Kiosk,${BARBERING},Kampala/Nakawa Division/Kireka,0772 555 666`,
    `Nakawa Kiosk Two,${BARBERING},Kampala/Nakawa Division/Nakawa Central,0772 777 888`,
  ])

  const { summary, unresolved } = importBusinessesFromCsv(ctx.app, file)

  assert.equal(summary.failed, 4)
  assert.equal(unresolved.length, 2, 'two distinct places, not four rows')

  const central = unresolved.find((entry) => entry.name === 'Nakawa Central')
  assert.ok(central, 'the ward is named, not the first segment of the path')
  assert.deepEqual(central.lines, [2, 3, 5], 'every line that wanted it is listed')
  assert.equal(central.parentPath, 'Uganda / Central Region / Kampala District / Kampala / Nakawa Division')

  const kireka = unresolved.find((entry) => entry.name === 'Kireka')
  assert.deepEqual(kireka.lines, [4])

  // The digest is a pure function of the file, so re-running it produces the
  // same report and a reviewer can diff the two.
  const again = importBusinessesFromCsv(ctx.app, file)
  assert.deepEqual(again.unresolved, unresolved)
})

test('an unknown category is reported with the parent it belongs under', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { unresolved } = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      `Nakawa Braider,goods-and-products/fashion-and-textiles/hair-braiding,Kampala/Nakawa Division,0772111222`,
    ]),
  )

  const entry = unresolved[0]
  assert.equal(entry.type, 'category')
  assert.equal(entry.name, 'hair-braiding')
  assert.equal(entry.parentPath, 'goods-and-products/fashion-and-textiles')
  assert.equal(entry.parentId, categoryAt(ctx.app, 'goods-and-products/fashion-and-textiles').id)
})

test('the missing places from a report can be added and the file re-imported', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const file = csvFile([
    `Nakawa Kiosk,${BARBERING},Kampala/Nakawa Division/Nakawa Central,0772 111 222`,
    `Kireka Kiosk,${BARBERING},Kampala/Nakawa Division/Kireka,0772 555 666`,
  ])

  const first = importBusinessesFromCsv(ctx.app, file)
  assert.equal(first.summary.created, 0)

  // What the operator does with the report: state the kind of place, which is
  // the one thing the importer refused to guess. A subcounty is what can sit
  // under a division here; a ward would need one of those first.
  const division = locationNamed(ctx.app, 'Nakawa Division')
  for (const entry of first.unresolved) {
    ctx.app.locations.create({
      name: entry.name,
      kind: 'subcounty',
      parentId: division.id,
      sourceId: 'field-survey-2026-09',
    })
  }

  const second = importBusinessesFromCsv(ctx.app, file)
  assert.equal(second.summary.created, 2, 'the same rows now resolve')
  assert.equal(second.unresolved.length, 0)

  // And the ordinary replay guarantee is unchanged by any of this.
  const third = importBusinessesFromCsv(ctx.app, file)
  assert.equal(third.summary.created, 0)
  assert.equal(third.summary.skipped, 2)
  assert.equal(ctx.app.businesses.all().length, 2)
})

test('a dry run reports what it would do and writes nothing', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const file = csvFile([
    `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222,hello@nakawa.ug`,
    `Kololo Cycles,${BARBERING},Kampala/Central Division,0772 333 444`,
  ])

  const { summary, rows } = importBusinessesFromCsv(ctx.app, file, { dryRun: true })

  assert.deepEqual(summary, {
    total: 2,
    created: 2,
    updated: 0,
    skipped: 0,
    failed: 0,
    dryRun: true,
  })
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['created', 'created'],
  )
  assert.equal(ctx.app.businesses.all().length, 0)
  assert.equal(ctx.app.db.prepare('SELECT count(*) AS c FROM contact_point').get().c, 0)
})

test('an import writes the listing, its contacts, services and skills', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      'Nakawa Hair Studio,' +
        BARBERING +
        ',Kampala/Nakawa Division,0772 111 222,hello@nakawa.ug,https://nakawa.ug,Plot 44 Kintu Road,"Hair cuts, Braiding",Barbering',
    ]),
  )
  assert.equal(summary.created, 1)

  const business = ctx.app.businesses.findBySlug('nakawa-hair-studio')
  assert.ok(business, 'the listing is findable by the slug derived from the name')
  assert.equal(business.sourceId, 'import:csv')
  assert.equal(business.status, 'draft', 'an imported listing is a draft until somebody verifies it')
  assert.equal(business.verificationState, 'unverified')
  assert.equal(business.website, 'https://nakawa.ug/')

  const profile = ctx.app.businesses.profile(business.id, { includePrivateContacts: true })
  assert.deepEqual(
    profile.locations.map((row) => row.addressText),
    ['Plot 44 Kintu Road'],
  )
  assert.deepEqual(
    profile.contacts.map((row) => `${row.kind}:${row.value}`).sort(),
    ['email:hello@nakawa.ug', 'phone:+256772111222', 'website:https://nakawa.ug/'],
  )
  assert.ok(
    profile.contacts.every((row) => row.isPublic === false),
    'a collected contact is not published before it is checked',
  )
  assert.deepEqual(
    profile.services.map((row) => row.name).sort(),
    ['Braiding', 'Hair cuts'],
  )
  assert.deepEqual(
    profile.skills.map((row) => row.name),
    ['Barbering'],
  )
})

test('a phone number is matched however it was typed', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`]),
  )

  const { summary, rows } = importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,+256 772 111 222`]),
  )

  assert.equal(summary.skipped, 1)
  assert.equal(summary.created, 0)
  assert.match(rows[0].detail, /phone matches "Nakawa Hair Studio"/)
})

test('a whatsapp number is recognised as the same number as a phone', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0700 111 222,,,`]),
  )

  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([{ name: 'Nakawa Hair Studio', category: BARBERING, location: 'Kampala/Nakawa Division', whatsapp: '0700111222' }], [
      'name',
      'category',
      'location',
      'whatsapp',
    ]),
  )

  assert.equal(summary.skipped, 1, 'a whatsapp number is the same business as a phone number')
  assert.equal(ctx.app.businesses.all().length, 1)
})

test('a dry run finds the duplicates a real run would', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  // The two rows type the same number differently, so this only works if the
  // in-file comparison uses the normalised value.
  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`,
      `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,+256772111222`,
    ]),
    { dryRun: true },
  )

  assert.equal(summary.created, 1)
  assert.equal(summary.skipped, 1)
})

test('a phone number in the website column is reported, not published', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  // "0772111222" is a valid phone number and a syntactically valid host, so
  // without this check the listing would carry https://7.232.146.146/ as its
  // website.
  const { summary, rows } = importBusinessesFromCsv(
    ctx.app,
    csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,,,0772111222`]),
  )

  assert.equal(summary.failed, 1)
  assert.match(rows[0].detail, /is a phone number, not a web address/)
  assert.equal(ctx.app.businesses.all().length, 0)
})

test('replaying a file imports nothing twice', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const file = csvFile([
    `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222,hello@nakawa.ug`,
    `Kololo Cycles,${BARBERING},Kampala/Central Division,0772 333 444,cycles@kololo.ug`,
  ])

  const first = importBusinessesFromCsv(ctx.app, file)
  const second = importBusinessesFromCsv(ctx.app, file)
  const third = importBusinessesFromCsv(ctx.app, file)

  assert.equal(first.summary.created, 2)
  assert.equal(second.summary.created, 0)
  assert.equal(third.summary.created, 0)
  assert.equal(second.summary.skipped, 2)
  assert.equal(third.summary.skipped, 2)
  assert.equal(ctx.app.businesses.all().length, 2)
})

test('two rows in one file that describe the same business are imported once', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { summary, rows } = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`,
      `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`,
    ]),
  )

  assert.equal(summary.created, 1)
  assert.equal(summary.skipped, 1)
  assert.match(rows[1].detail, /already seen in this file/)
})

test('a row with no contact details is matched on its name in its location', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([
      { name: 'Nakawa Hair Studio', category: BARBERING, location: 'Kampala/Nakawa Division' },
      { name: 'Nakawa Hair Studio', category: BARBERING, location: 'Kampala/Central Division' },
    ]),
  )

  assert.equal(summary.created, 2, 'the same name in a different location is a different business')
})

test('a bad row does not take the rest of the file with it', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const columns = [...COLUMNS, 'status', 'latitude']
  const { summary, rows } = importBusinessesFromCsv(
    ctx.app,
    csvFile(
      [
        { name: 'Good One', category: BARBERING, location: 'Kampala/Nakawa Division', phone: '0772 000 001' },
        { name: 'Bad Category', category: 'services/does-not-exist', location: 'Kampala', phone: '0772 000 002' },
        { name: 'Good Two', category: BARBERING, location: 'Kampala/Central Division', phone: '0772 000 003' },
        { name: 'Bad Status', category: BARBERING, location: 'Kampala', phone: '0772 000 004', status: 'maybe' },
        { name: 'Bad Latitude', category: BARBERING, location: 'Kampala', phone: '0772 000 005', latitude: 'north' },
      ],
      columns,
    ),
  )

  assert.equal(summary.total, 5)
  assert.equal(summary.created, 2)
  assert.equal(summary.failed, 3)

  // The report has to point at the line, because that is what an operator edits.
  assert.deepEqual(
    rows.map((row) => [row.line, row.outcome]),
    [
      [2, 'created'],
      [3, 'failed'],
      [4, 'created'],
      [5, 'failed'],
      [6, 'failed'],
    ],
  )
  assert.match(rows[1].detail, /is not a category/)
  assert.match(rows[3].detail, /status/i)
  assert.match(rows[4].detail, /latitude/)

  assert.deepEqual(
    ctx.app.businesses.all().map((row) => row.name).sort(),
    ['Good One', 'Good Two'],
  )
})

test('a rejected contact does not leave a listing behind', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile([{ name: 'Kampala Notary', category: ACCOUNTING, location: 'Kampala/Central Division', phone: '0772 000 010', email: 'not-an-email-address' }]),
  )

  assert.equal(summary.failed, 1)
  assert.equal(
    ctx.app.businesses.all().length,
    0,
    'a half-written listing is worse than no listing, so the row rolls back entirely',
  )
})

test('an import without reference data says so instead of failing every row', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-bare-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'bare.db') })
  const app = openApp({ config })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  assert.throws(
    () => importBusinessesFromCsv(app, csvFile([`Anything,${BARBERING},Kampala,0772 000 020`])),
    /Reference data is missing/,
  )
})

test('a column the platform does not know is ignored rather than fatal', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const { summary } = importBusinessesFromCsv(
    ctx.app,
    csvFile(
      [
        {
          name: 'Nakawa Hair Studio',
          category: BARBERING,
          location: 'Kampala/Nakawa Division',
          phone: '0772 111 222',
          comment: 'someones notes',
        },
      ],
      ['name', 'category', 'location', 'phone', 'email', 'website', 'comment'],
    ),
  )

  assert.equal(summary.created, 1)
  const business = ctx.app.businesses.findBySlug('nakawa-hair-studio')
  assert.equal(business.description, null, 'an unknown column is not smuggled into a field')
})

test('a row is validated before anything is written for it', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  assert.throws(
    () => buildImportRow(ctx.app, { name: 'x', category: BARBERING, location: 'Kampala' }),
    /name must be 2 to 160 characters/,
  )
  assert.throws(
    () =>
      buildImportRow(ctx.app, {
        name: 'Fine Name',
        category: BARBERING,
        location: 'Kampala',
        latitude: 'north',
      }),
    /The latitude column has "north", which is not a number/,
  )
  assert.throws(
    () =>
      buildImportRow(ctx.app, {
        name: 'Fine Name',
        category: BARBERING,
        location: 'Kampala',
        founded_year: '19990',
      }),
    /The founded_year column has "19990", which is outside the allowed range/,
  )
})

test('an import over the api needs the import capability', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-import-api-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'api.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  t.after(async () => {
    await server.close()
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const file = csvFile([`Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`])

  const anonymous = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    payload: { csv: file },
  })
  assert.equal(anonymous.statusCode, 401)

  app.users.create({ email: 'viewer@kampala.ug', password: PASSWORD, displayName: 'Viewer', role: 'viewer' })
  const viewerLogin = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'viewer@kampala.ug', password: PASSWORD },
  })
  const viewerToken = viewerLogin.json().data.token

  const refused = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { csv: file },
  })
  assert.equal(refused.statusCode, 403, 'a viewer may not import businesses')

  app.users.create({ email: 'admin@kampala.ug', password: PASSWORD, displayName: 'Administrator', role: 'admin' })
  const adminLogin = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'admin@kampala.ug', password: PASSWORD },
  })
  const admin = { authorization: `Bearer ${adminLogin.json().data.token}` }

  // dryRun defaults to true: an http call must not create a hundred listings
  // from a payload nobody has read.
  const dry = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: admin,
    payload: { csv: file },
  })
  assert.equal(dry.statusCode, 200, dry.body)
  const dryBody = dry.json()
  assert.equal(dryBody.data.summary.created, 1)
  assert.equal(dryBody.meta.dryRun, true)
  assert.equal(app.businesses.all().length, 0, 'the default call wrote nothing')

  const applied = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: admin,
    payload: { csv: file, dryRun: false, sourceId: 'field-survey-2026-09' },
  })
  assert.equal(applied.statusCode, 200, applied.body)
  assert.equal(applied.json().data.summary.created, 1)
  const business = app.businesses.findBySlug('nakawa-hair-studio')
  assert.equal(business.sourceId, 'field-survey-2026-09')

  const schema = await server.inject({
    method: 'GET',
    url: '/api/v1/admin/imports/businesses/schema',
    headers: admin,
  })
  assert.equal(schema.statusCode, 200)
  assert.deepEqual(schema.json().data.required, ['name', 'category', 'location'])
})

test('a rejected import can be fixed over the api and re-run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-import-loop-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'loop.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  t.after(async () => {
    await server.close()
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  app.users.create({ email: 'editor@kampala.ug', password: PASSWORD, displayName: 'Ed', role: 'editor' })
  app.users.create({ email: 'analyst@kampala.ug', password: PASSWORD, displayName: 'An', role: 'analyst' })
  const tokenFor = async (email) => {
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    })
    return { authorization: `Bearer ${login.json().data.token}` }
  }
  const editor = await tokenFor('editor@kampala.ug')
  const analyst = await tokenFor('analyst@kampala.ug')

  // A survey of one division, written the way somebody writes it on paper.
  const file = csvFile([
    `Nakawa Kiosk,${BARBERING},Kampala/Nakawa Division/Kireka,0772 111 222`,
    `Kireka Salon,${BARBERING},Kampala/Nakawa Division/Kireka,0772 333 444`,
    `Nakawa Chemist,${BARBERING},Kampala/Nakawa Division/Kasaato,0772 555 666`,
  ])

  const first = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: editor,
    payload: { csv: file },
  })
  assert.equal(first.statusCode, 200, first.body)
  const report = first.json().data
  assert.equal(report.summary.failed, 3, 'nothing was placed, because nothing resolved')
  assert.equal(report.unresolved.length, 2, 'two places, not three rows')

  const division = locationNamed(app, 'Nakawa Division')
  const missing = report.unresolved.map((entry) => ({
    name: entry.name,
    // The one thing the importer will not decide. A ward under a division is
    // refused by the hierarchy, so the operator states the kind and finds out
    // immediately if it does not fit.
    kind: 'subcounty',
    parentId: entry.parentId ?? division.id,
  }))
  assert.deepEqual(missing.map((entry) => entry.name), ['Kasaato', 'Kireka'])
  for (const entry of missing) {
    assert.equal(entry.parentId, division.id, 'both belong to the division the file named')
  }

  // Adding reference data is a separate capability from importing businesses.
  const refused = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    headers: analyst,
    payload: { locations: missing },
  })
  assert.equal(refused.statusCode, 403, 'an analyst may not change the reference trees')

  const anonymous = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    payload: { locations: missing },
  })
  assert.equal(anonymous.statusCode, 401)

  const added = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    headers: editor,
    payload: { locations: missing },
  })
  assert.equal(added.statusCode, 201, added.body)
  assert.deepEqual(added.json().data.counts, { created: 2, skipped: 0, failed: 0 })

  // Sending the same report again is the ordinary case, not an error: the
  // operator pressed the button twice, or a retry landed.
  const again = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    headers: editor,
    payload: { locations: missing },
  })
  assert.equal(again.statusCode, 201)
  assert.deepEqual(again.json().data.counts, { created: 0, skipped: 2, failed: 0 })

  // A place that cannot sit where it was sent is reported on its own, and the
  // rest of the batch still lands. A ward under a division is refused by the
  // hierarchy, which is the model doing its job: a Kampala ward belongs under a
  // subcounty, and the operator has to say which.
  const mixed = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    headers: editor,
    payload: {
      locations: [
        { name: 'Ntinda Ward', kind: 'ward', parentId: division.id },
        { name: 'Ntinda', kind: 'subcounty', parentId: division.id },
      ],
    },
  })
  assert.equal(mixed.statusCode, 201, mixed.body)
  assert.deepEqual(mixed.json().data.counts, { created: 1, skipped: 0, failed: 1 })
  assert.match(mixed.json().data.failed[0].reason, /cannot be nested inside a "division"/)
  assert.equal(locationNamed(app, 'Ntinda').kind, 'subcounty')

  // Re-sending an entry that already exists under the same parent is a skip
  // rather than a failure, because the same report sent twice is the expected
  // case and a half-applied batch has to be retryable.
  const resend = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations/bulk',
    headers: editor,
    payload: { locations: [{ name: 'ntinda', kind: 'subcounty', parentId: division.id }] },
  })
  assert.deepEqual(resend.json().data.counts, { created: 0, skipped: 1, failed: 0 })

  // An unknown kind is refused by the schema rather than stored as a typo.
  const badKind = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/locations',
    headers: editor,
    payload: { name: 'Somewhere', kind: 'province' },
  })
  assert.equal(badKind.statusCode, 400, badKind.body)

  // And now the file imports, then replays as duplicates.
  const second = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: editor,
    payload: { csv: file, dryRun: false },
  })
  assert.equal(second.statusCode, 200, second.body)
  const appliedReport = second.json().data
  assert.equal(appliedReport.summary.created, 3)
  assert.equal(appliedReport.unresolved.length, 0)

  const third = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: editor,
    payload: { csv: file, dryRun: false },
  })
  assert.equal(third.json().data.summary.created, 0)
  assert.equal(third.json().data.summary.skipped, 3)
  assert.equal(app.businesses.all().length, 3)

  // The listings landed under the places the operator added, which is the whole
  // point of the loop: the report said where, and the tree now says so too.
  const salon = app.businesses.findBySlug('kireka-salon')
  assert.equal(salon.primaryLocationId, locationNamed(app, 'Kireka').id)
})

test('a category branch can be reported and the missing child added', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-branch-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'branch.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  t.after(async () => {
    await server.close()
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  app.users.create({ email: 'editor@kampala.ug', password: PASSWORD, displayName: 'Ed', role: 'editor' })
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'editor@kampala.ug', password: PASSWORD },
  })
  const editor = { authorization: `Bearer ${login.json().data.token}` }

  const report = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: editor,
    payload: {
      csv: csvFile([
        `Nakawa Braider,services/beauty-and-personal-care,Kampala/Nakawa Division,0772111222`,
      ]),
    },
  })
  const body = report.json().data
  assert.equal(body.summary.failed, 1)
  assert.equal(body.unresolved[0].type, 'category_branch')
  assert.match(body.rows[0].detail, /has child categories/)

  // A branch is not something to create: the operator was told to name a leaf.
  // Adding a child under the branch is the fix, and then the same file works.
  const branch = categoryAt(app, 'services/beauty-and-personal-care')
  const added = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/reference/categories/bulk',
    headers: editor,
    payload: { categories: [{ name: 'Hair Braiding', parentId: branch.id }] },
  })
  assert.equal(added.statusCode, 201, added.body)
  assert.deepEqual(added.json().data.counts, { created: 1, skipped: 0, failed: 0 })

  const slug = added.json().data.created[0].category.pathSlugs
  const reimported = await server.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/businesses',
    headers: editor,
    payload: {
      csv: csvFile([`Nakawa Braider,${slug},Kampala/Nakawa Division,0772111222`]),
      dryRun: false,
    },
  })
  assert.equal(reimported.json().data.summary.created, 1, reimported.body)
})

test('the import cli reports a dry run and exits non-zero when rows fail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-import-cli-'))
  const file = path.join(dir, 'businesses.csv')
  fs.writeFileSync(
    file,
    csvFile([
      `Nakawa Hair Studio,${BARBERING},Kampala/Nakawa Division,0772 111 222`,
      `Bad Category,services/does-not-exist,Kampala,0772 000 002`,
    ]),
  )
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/import.js', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, KIP_DATA_DIR: path.join(dir, 'data') },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })

  // The importer refuses to run without the taxonomy, so the cli is pointed at a
  // directory that has been seeded the way a real install would be.
  return run([]).then(() =>
    new Promise((resolve) => {
      const seed = spawn(process.execPath, ['scripts/seed.js'], {
        cwd: process.cwd(),
        env: { ...process.env, KIP_DATA_DIR: path.join(dir, 'data') },
      })
      let stderr = ''
      seed.stderr.on('data', (chunk) => (stderr += chunk))
      seed.on('close', (code) => resolve({ code, stderr }))
    }),
  ).then((seed) => {
    assert.equal(seed.code, 0, seed.stderr)
    return run([file, '--dry-run'])
  }).then((first) => {
    assert.equal(first.code, 1, 'a failed row is a failed command')
    assert.match(first.stdout, /would be created/)
    assert.match(first.stdout, /Rows that need fixing/)

    return run([file, '--source', 'cli-test'])
  }).then((second) => {
    assert.equal(second.code, 1)
    assert.match(second.stdout, /1 created, 0 skipped, 1 failed/)
    assert.match(second.stdout, /nakawa-hair-studio/)
  })
})
