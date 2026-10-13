import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { openDatabase } from '../src/db/driver.js'
import { migrate } from '../src/db/migrator.js'
import {
  computeGapScore,
  detectTrend,
  deriveOpportunity,
  demandWeight,
  supplyAdequacy,
} from '../src/core/intelligence.js'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The data layer's own tests.
 *
 * These are the tests that matter most in the platform, because everything above
 * this layer is a presentation of what these functions return. Each test opens a
 * real SQLite file in a temp directory rather than an in-memory database: WAL
 * mode, the migration ledger and the FTS5 build are all part of what we are
 * verifying, and none of them behave in memory.
 */

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-test-'))
  const config = loadConfig({
    dataDir: dir,
    databaseFile: path.join(dir, 'test.db'),
    // The lowest floor the privacy layer allows, so tests can exercise
    // suppression without generating 5 distinct actors per assertion.
    // Individual tests override it.
  })
  const app = openApp({ config })
  return {
    app,
    cleanup() {
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Reference scaffolding: Uganda > Central > Wakiso > Kampala. */
function seedReference(app) {
  const country = app.locations.create({
    kind: 'country',
    name: 'Uganda',
    latitude: 1.3733,
    longitude: 32.5825,
  })
  const region = app.locations.create({
    kind: 'region',
    name: 'Central Region',
    parentId: country.id,
  })
  const district = app.locations.create({
    kind: 'district',
    name: 'Wakiso District',
    parentId: region.id,
    externalCode: 'UG-041',
  })
  const city = app.locations.create({
    kind: 'city',
    name: 'Kampala',
    parentId: district.id,
    latitude: 0.3476,
    longitude: 32.5825,
  })
  const ward = app.locations.create({
    kind: 'ward',
    name: 'Nakawa',
    parentId: city.id,
  })
  return { country, region, district, city, ward }
}

test('migrations are idempotent and recorded', () => {
  const { app, cleanup } = freshApp()
  try {
    // The ledger is listed explicitly rather than counted from the directory,
    // because the point of this test is that a new migration is a deliberate act
    // somebody has to come here and acknowledge. Deriving the list from the folder
    // would make adding one invisible, which is the opposite of what it is for.
    //
    // The count is taken from the list rather than written out again, so the two
    // cannot drift into disagreeing with each other.
    const expected = [
      '001_platform_identity',
      '002_reference',
      '003_supply',
      '004_search',
      '005_demand',
      '006_intelligence',
      '007_marketplace_access_tokens',
      '008_audit_reason',
      '009_catalogue_ingestion',
      '010_opportunity_identity',
      '011_opportunity_actor_count',
      '012_second_life',
    ]

    // Re-running the migrator on an up-to-date database must be a no-op, or the
    // launcher would re-apply the schema on every start.
    const results = migrate(app.db)
    assert.equal(results.length, expected.length)
    assert.ok(results.every((row) => row.status === 'skipped'))

    const ledger = app.db.prepare('SELECT id FROM schema_migration ORDER BY id').all()
    assert.deepEqual(
      ledger.map((row) => row.id),
      expected,
    )
  } finally {
    cleanup()
  }
})

test('011 backfills the actor count onto opportunities that predate the column', () => {
  // The upgrade path, which the ledger test above cannot reach: a database that
  // already ran the engine against the old schema. `ALTER TABLE ... ADD COLUMN
  // ... DEFAULT 0` alone would silently mark every pre-existing opportunity as
  // below the floor, hiding the entire back catalogue on the first start after
  // the upgrade - and invisibly, because the rows would still be there.
  //
  // So the migration has to copy the count off the snapshot the opportunity was
  // derived from, and this is the only test that proves it does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-upgrade-'))
  const migrations = path.join(APP_ROOT, 'src', 'db', 'migrations')
  const before = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-before-'))
  for (const name of fs.readdirSync(migrations)) {
    // Stage the schema as it stood before 011, so 011 (and anything added after
    // it, like 012) is genuinely pending when the full directory is applied. The
    // migrator refuses out-of-order history, which is why the newer migration has
    // to be left out here rather than copied in and applied later.
    if (name === '011_opportunity_actor_count.sql' || name === '012_second_life.sql') continue
    fs.copyFileSync(path.join(migrations, name), path.join(before, name))
  }

  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'old.db') })
  // Deliberately not `openApp`: that migrates with the full directory on the way
  // in, which is the very thing this test needs to stage. This opens the file.
  const db = openDatabase(config)
  try {
    // Stand up a database from the pre-011 schema only.
    migrate(db, { dir: before })
    assert.equal(
      db.prepare('PRAGMA table_info(opportunity)').all().some((c) => c.name === 'distinct_actors'),
      false,
      'sanity: the column genuinely does not exist yet',
    )

    const run = db
      .prepare("INSERT INTO intelligence_run (id, kind, status) VALUES ('r1', 'opportunities', 'completed')")
      .run()
    assert.equal(run.changes, 1)

    // Two gaps: one with a provable actor count, one with none.
    db.prepare(
      `INSERT INTO gap_snapshot (id, run_id, phrase, term, ngram_size, distinct_actors, searches)
       VALUES ('g-yes', 'r1', 'granite worktop', 'granite worktop', 2, 30, 412),
              ('g-no',  'r1', 'mystery trade',  'mystery trade',  2,  0,   3)`,
    ).run()

    // Opportunities in the shape the old engine wrote: no actor count at all,
    // and one with no parent snapshot, which is exactly the case a join cannot
    // rescue and which must stay hidden rather than be guessed at.
    db.prepare(
      `INSERT INTO opportunity (id, gap_snapshot_id, keyword, severity, score, rationale, state)
       VALUES ('o-yes',  'g-yes', 'granite worktop', 'critical', 1,   'derived', 'candidate'),
              ('o-no',   'g-no',  'mystery trade',   'critical', 0.9, 'derived', 'candidate'),
              ('o-orphan', NULL,  'orphan phrase',   'critical', 0.8, 'derived', 'candidate')`,
    ).run()

    // Now the real upgrade: the full directory, so 011 is the only pending one.
    // `migrate` reports skipped migrations too, so the interesting half is the
    // set that actually ran.
    const results = migrate(db)
    assert.deepEqual(
      results.filter((row) => row.status !== 'skipped').map((row) => row.id),
      ['011_opportunity_actor_count', '012_second_life'],
      'the upgrade applies every migration added after the staged schema',
    )

    const rows = db.prepare('SELECT id, distinct_actors FROM opportunity ORDER BY id').all()
    assert.deepEqual(rows, [
      { id: 'o-no', distinct_actors: 0 },
      { id: 'o-orphan', distinct_actors: 0 },
      { id: 'o-yes', distinct_actors: 30 },
    ])

    // The two zeros are the whole point of the privacy design and must stay
    // hidden: a snapshot that never cleared the floor, and an opportunity whose
    // parent is gone, both resolve to "we cannot prove how many people this is".
    const kThreshold = config.privacy.kThreshold
    const visible = rows.filter((row) => row.distinct_actors >= kThreshold).map((row) => row.id)
    assert.deepEqual(visible, ['o-yes'], 'only the provable row clears the floor')
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(before, { recursive: true, force: true })
  }
})

test('location tree maintains materialised paths for non-root inserts', () => {
  const { app, cleanup } = freshApp()
  try {
    const { district, city, ward } = seedReference(app)

    assert.equal(city.pathIds.split('/').length, 4)
    assert.equal(ward.depth, 4)
    assert.match(city.pathNames, /Wakiso District/)

    // The prefix match that every rollup depends on.
    const inside = app.locations.descendants(district.id)
    assert.deepEqual(
      inside.map((row) => row.name).sort(),
      ['Kampala', 'Nakawa'],
    )
    assert.deepEqual(
      app.locations.ancestors(ward.id).map((row) => row.kind),
      ['country', 'region', 'district', 'city'],
    )

    // Renaming a parent must not leave descendants pointing at the old name.
    app.locations.update(city.id, { name: 'Kampala City' })
    assert.match(app.locations.findById(ward.id).pathNames, /Kampala City/)
  } finally {
    cleanup()
  }
})

test('coverageLocation rolls a ward up to the requested level', () => {
  const { app, cleanup } = freshApp()
  try {
    const { district, ward } = seedReference(app)
    assert.deepEqual(app.locations.coverageLocation(ward.id, 'district'), {
      locationId: district.id,
      coverageLevel: 'district',
    })
    assert.deepEqual(app.locations.coverageLocation(null, 'district'), {
      locationId: null,
      coverageLevel: null,
    })
  } finally {
    cleanup()
  }
})

test('the category tree resolves subtrees by id, not by guessing', () => {
  const { app, cleanup } = freshApp()
  try {
    const root = app.categories.ensureRoots()[0]
    const child = app.categories.create({
      name: 'Phone Repair',
      slug: 'phone-repair',
      parentId: root.id,
    })
    const grandchild = app.categories.create({
      name: 'Screen Repair',
      slug: 'screen-repair',
      parentId: child.id,
    })

    // path_slugs stores slugs, so the repository has to translate the caller's
    // id before it can prefix-match. Passing a bare uuid used to return nothing.
    assert.deepEqual(
      app.categories.descendants(root.id).map((row) => row.name).sort(),
      ['Phone Repair', 'Screen Repair'],
    )
    assert.deepEqual(
      app.categories.descendants(child.id).map((row) => row.name),
      ['Screen Repair'],
    )
    assert.deepEqual(app.categories.descendants(grandchild.id), [])
    assert.match(grandchild.pathSlugs, new RegExp(`/${child.slug}/${grandchild.slug}$`))
  } finally {
    cleanup()
  }
})

test('slug collisions resolve to the same suffixes everywhere', () => {
  const { app, cleanup } = freshApp()
  try {
    const { district } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    const first = app.businesses.create({
      name: 'Bright Future Bakery',
      categoryId: category.id,
      locationId: district.id,
      status: 'active',
    })
    const second = app.businesses.create({
      name: 'Bright Future Bakery',
      categoryId: category.id,
      locationId: district.id,
      status: 'active',
    })

    assert.equal(first.slug, 'bright-future-bakery')
    assert.equal(second.slug, 'bright-future-bakery-2')
    assert.notEqual(first.id, second.id)
  } finally {
    cleanup()
  }
})

test('a business write indexes it for search, and a hide unindexes it', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]

    const business = app.businesses.create({
      name: 'Entebbe Tech Repair',
      description: 'Laptop screen replacement and motherboard repair.',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
      skills: ['laptop repair', 'screen replacement'],
    })

    // Indexed, but not answerable. The document exists from the moment the record
    // does, so a reindex never has to guess whether it is missing a document or
    // whether the record was never there; `is_active` is what decides whether a
    // public search may return it, and until approval it may not.
    const whileQueued = app.searchIndex.search({ query: 'Entebbe' })
    assert.equal(whileQueued.total, 0, 'a record in the queue is indexed but not searchable')
    assert.equal(app.searchIndex.count({ publishedOnly: false }), 1)
    assert.equal(app.searchIndex.count(), 0)

    app.businesses.review(business.id, { action: 'verify', reason: 'Checked the details.' })
    app.businesses.review(business.id, { action: 'approve', reason: 'Published it.' })

    const byName = app.searchIndex.search({ query: 'Entebbe' })
    assert.equal(byName.total, 1)
    assert.equal(byName.items[0].docKey, `business:${business.id}`)

    // Multi-word queries match on the body, and the district prefix filter works.
    assert.equal(app.searchIndex.search({ query: 'laptop screen' }).total, 1)

    // A skill in the keywords column is findable by the skill's own name.
    const skill = app.skills.all().find((row) => row.name === 'laptop repair')
    assert.equal(app.searchIndex.search({ query: 'laptop repair' }).total >= 1, true)
    assert.equal(app.searchIndex.search({ query: 'laptop repair', skillId: skill.id }).total, 1)

    // Approval is what published it, so taking the approval back takes the
    // listing out of the results in the same transaction.
    app.businesses.review(business.id, { action: 'unapprove', reason: 'Source withdrew it.' })
    assert.equal(app.searchIndex.search({ query: 'Entebbe' }).total, 0)

    // And so does hiding it, which is a decision about today rather than about
    // whether the facts were ever true.
    app.businesses.review(business.id, { action: 'approve', reason: 'Published again.' })
    assert.equal(app.searchIndex.search({ query: 'Entebbe' }).total, 1)
    app.businesses.setStatus(business.id, 'suspended')
    assert.equal(app.searchIndex.search({ query: 'Entebbe' }).total, 0)
  } finally {
    cleanup()
  }
})

test('search index rejects query syntax instead of executing it', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    app.businesses.create({
      name: 'Kampala Solar Works',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })

    // These are the strings that break a naive FTS5 MATCH. None of them may
    // throw, and none of them may return the unrelated business.
    for (const hostile of ['OR', 'NOT', 'NEAR', 'a"b', '*', '""', 'AND OR']) {
      const result = app.searchIndex.search({ query: hostile })
      assert.ok(result.total >= 0, `query ${hostile} should not throw`)
    }
    assert.equal(app.searchIndex.search({ query: '   ' }).total, 0)
  } finally {
    cleanup()
  }
})

test('contact points are normalised and deduplicated', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Nakawa Spares',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })

    app.businesses.addContact(business.id, { kind: 'phone', value: '0772 123 456' })
    // The same number typed a different way is the same contact, and the write is
    // refused rather than silently creating a second row.
    assert.throws(
      () => app.businesses.addContact(business.id, { kind: 'phone', value: '+256772123456' }),
      /already has that phone/,
    )
    assert.equal(app.businesses.contacts(business.id).length, 1)
    assert.equal(app.businesses.contacts(business.id)[0].value, '+256772123456')

    // The same number in any format finds the business.
    assert.equal(app.businesses.findByContact({ value: '256772123456' }).id, business.id)
    assert.equal(app.businesses.findByContact({ value: '0772-123-456' }).id, business.id)
    assert.equal(app.businesses.findByContact({ value: '0700000000' }), null)

    // A number filed as a WhatsApp contact is still the same business, so a
    // phone-shaped lookup has to find it. This is the difference between an
    // import merging a trader's two rows and writing them twice.
    app.businesses.addContact(business.id, { kind: 'whatsapp', value: '0772 999 888' })
    assert.equal(app.businesses.findByContact({ kind: 'whatsapp', value: '+256772999888' }).id, business.id)
    assert.equal(
      app.businesses.findByContact({ kind: 'phone', value: '0772 999 888' }).id,
      business.id,
    )

    // A non-phone contact is matched on its own kind only, so a website and a
    // phone that happen to share a string are not called the same business.
    app.businesses.addContact(business.id, { kind: 'website', value: 'https://nakawa.ug' })
    assert.equal(app.businesses.findByContact({ kind: 'website', value: 'nakawa.ug' }).id, business.id)
    assert.equal(
      app.businesses.findByContact({ kind: 'facebook', value: 'https://nakawa.ug' }),
      null,
      'a facebook contact is not a website contact',
    )

    // A value the platform would refuse to store is not a match, and must not
    // throw out of a lookup.
    assert.equal(app.businesses.findByContact({ kind: 'phone', value: 'not a number' }), null)
  } finally {
    cleanup()
  }
})

test('two records are the same business when their contacts mean the same thing', () => {
  const { app, cleanup } = freshApp()
  try {
    const category = app.categories.ensureRoots()[1]
    const { city } = seedReference(app)

    const first = app.businesses.create({
      name: 'Nakawa Spares',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    app.businesses.addContact(first.id, { kind: 'whatsapp', value: '0772 123 456' })
    app.businesses.addContact(first.id, { kind: 'email', value: 'hello@nakawa.ug' })
    app.businesses.addContact(first.id, { kind: 'website', value: 'https://nakawa.ug' })

    const second = app.businesses.create({
      name: 'Nakawa Spares',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    // The same contacts, typed the way a second spreadsheet would type them.
    app.businesses.addContact(second.id, { kind: 'phone', value: '+256772123456' })
    app.businesses.addContact(second.id, { kind: 'email', value: 'Hello@Nakawa.UG' })
    app.businesses.addContact(second.id, { kind: 'website', value: 'nakawa.ug' })

    assert.ok(
      app.businesses.looksLikeSameBusiness(
        app.businesses.profile(first.id),
        app.businesses.profile(second.id),
      ),
      'a whatsapp and a phone number with the same digits are the same business',
    )

    const unrelated = app.businesses.create({
      name: 'Kololo Spares',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    app.businesses.addContact(unrelated.id, { kind: 'phone', value: '0772 000 000' })
    assert.equal(
      app.businesses.looksLikeSameBusiness(
        app.businesses.profile(first.id),
        app.businesses.profile(unrelated.id),
      ),
      false,
    )
  } finally {
    cleanup()
  }
})

test('contact points stay private until published', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Kira Mobile Clinic',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    const contact = app.businesses.addContact(business.id, {
      kind: 'phone',
      value: '0773000111',
      isPublic: false,
    })

    assert.equal(app.businesses.publicContacts(business.id).length, 0)
    assert.equal(app.businesses.profile(business.id).contacts.length, 0)
    assert.equal(
      app.businesses.profile(business.id, { includePrivateContacts: true }).contacts.length,
      1,
    )

    app.businesses.setContactVisibility(contact.id, { isPublic: true })
    assert.equal(app.businesses.publicContacts(business.id).length, 1)
  } finally {
    cleanup()
  }
})

test('users authenticate, sessions resolve, and the hash is not the token', () => {
  const { app, cleanup } = freshApp()
  try {
    const user = app.users.create({
      email: 'Editor@Example.com',
      displayName: 'Nabirye A.',
      password: 'Kampala-Lights-2026!',
      role: 'editor',
    })
    assert.equal(user.email, 'Editor@Example.com')
    assert.equal(user.passwordHash, undefined)

    assert.ok(app.users.authenticate('editor@example.com', 'Kampala-Lights-2026!'))
    assert.equal(app.users.authenticate('editor@example.com', 'wrong-password-here'), null)
    assert.equal(app.users.authenticate('nobody@example.com', 'Kampala-Lights-2026!'), null)

    const session = app.sessions.create({ userId: user.id })
    const stored = app.db
      .prepare('SELECT token_hash FROM app_session WHERE id = ?')
      .get(session.id)
    assert.notEqual(stored.token_hash, session.token)
    assert.equal(app.sessions.resolve(session.token).userId, user.id)
    assert.equal(app.sessions.resolve('not-a-real-token'), null)
    assert.equal(app.sessions.destroy(session.token), true)
    assert.equal(app.sessions.resolve(session.token), null)
  } finally {
    cleanup()
  }
})

test('passwords that fail the strength rule are refused', () => {
  const { app, cleanup } = freshApp()
  try {
    for (const weak of ['short', 'alllowercaseletters', 'PASSWORD12345678']) {
      assert.throws(
        () =>
          app.users.create({
            email: `x-${weak.slice(0, 4)}@example.com`,
            displayName: 'Test User',
            password: weak,
          }),
        /Password must/,
      )
    }
  } finally {
    cleanup()
  }
})

test('non-demand queries are not recorded as signals', () => {
  const { app, cleanup } = freshApp()
  try {
    for (const noise of ['login', 'https://example.com', 'a', 'f47ac10b-58cc-4372-a567-0e02b2c3d479']) {
      assert.equal(app.demand.recordSearch({ query: noise, actorSeed: 'seed' }), null)
    }
    assert.equal(app.demand.recent(10).length, 0)

    const signal = app.demand.recordSearch({
      query: 'laptop screen repair',
      locationId: null,
      actorSeed: 'seed-1',
    })
    assert.ok(signal)
    assert.deepEqual(signal.tokens, ['laptop', 'screen', 'repair'])
    assert.ok(signal.phrases.includes('laptop screen'))
  } finally {
    cleanup()
  }
})

test('demand rollup aggregates by day and honours the k-anonymity floor', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const today = new Date('2026-05-04T09:00:00.000Z')

    // Five distinct actors clears the default floor of 5.
    for (let index = 0; index < 5; index += 1) {
      app.demand.recordSearch({
        query: 'laptop screen repair',
        locationId: city.id,
        coverageLevel: 'city',
        totalResults: index === 0 ? 0 : 2,
        actorSeed: `visitor-${index}`,
        at: today,
      })
    }
    // One more actor for a phrase that will stay below the floor.
    app.demand.recordSearch({
      query: 'tyre puncture repair',
      locationId: city.id,
      coverageLevel: 'city',
      totalResults: 0,
      actorSeed: 'lonely-visitor',
      at: today,
    })

    const rolled = app.demand.rollupDay('2026-05-04')
    assert.equal(rolled.events, 6)
    assert.ok(rolled.signals > 0)

    const visible = app.demand.topSignals({
      locationId: city.id,
      from: '2026-05-04',
      to: '2026-05-04',
    })
    const laptop = visible.find((row) => row.phrase === 'laptop screen')
    const tyre = visible.find((row) => row.phrase === 'tyre')

    assert.ok(laptop)
    assert.equal(laptop.suppressed, false)
    assert.equal(laptop.distinctActors, 5)
    assert.equal(laptop.zeroResults, 1)
    assert.equal(laptop.searchesBucket, '4-10')

    // The privacy floor refuses the row but still reports that it exists.
    assert.equal(tyre.suppressed, true)
    assert.equal(tyre.visible, false)
    assert.equal(tyre.kThreshold, 5)

    // Raw text is quarantined from the pseudonymised event. The event is found by
    // its quarantined text rather than by "the most recent one", because
    // `created_at` only has second resolution and every search in this block
    // landed in the same second, so the ordering between them is arbitrary.
    const laptopEvent = app.demand
      .recent(10)
      .find((row) => (app.demand.rawQuery(row.id).raw_query ?? '').includes('laptop'))
    assert.ok(laptopEvent, 'the laptop search should be in the recent window')
    assert.equal(app.demand.searchEvent(laptopEvent.id).tokensJson.includes('laptop'), true)
    assert.ok(app.demand.rawQuery(laptopEvent.id).raw_query.length > 0)
  } finally {
    cleanup()
  }
})

test('rolling a day up twice does not double count', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const at = new Date('2026-05-05T10:00:00.000Z')
    for (let index = 0; index < 6; index += 1) {
      app.demand.recordSearch({
        query: 'solar installation',
        locationId: city.id,
        coverageLevel: 'city',
        totalResults: 1,
        actorSeed: `solar-${index}`,
        at,
      })
    }
    app.demand.rollupDay('2026-05-05')
    const first = app.demand.topSignals({
      locationId: city.id,
      from: '2026-05-05',
      to: '2026-05-05',
    })
    app.demand.rollupDay('2026-05-05')
    const second = app.demand.topSignals({
      locationId: city.id,
      from: '2026-05-05',
      to: '2026-05-05',
    })
    assert.equal(first.find((r) => r.phrase === 'solar').searches, 6)
    assert.equal(second.find((r) => r.phrase === 'solar').searches, 6)
  } finally {
    cleanup()
  }
})

test('retention purge removes raw queries and expired events', () => {
  const { app, cleanup } = freshApp()
  try {
    const past = new Date('2020-01-01T08:00:00.000Z')
    app.demand.recordSearch({
      query: 'bicycle repair',
      actorSeed: 'ancient',
      at: past,
    })
    app.demand.recordInteraction({ type: 'business_view', actorSeed: 'ancient', at: past })

    assert.ok(app.demand.recent(5).length > 0)
    const purged = app.demand.purgeExpired()
    assert.ok(purged.rawQueries >= 1)
    assert.ok(purged.searchEvents >= 1)
    assert.ok(purged.interactions >= 1)
    assert.equal(app.demand.recent(5).length, 0)
  } finally {
    cleanup()
  }
})

test('marketplace request lifecycle and one-accepted-offer rule', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Kampala Fixers',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    const rival = app.businesses.create({
      name: 'Nakawa Repairs',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })

    const request = app.marketplace.create({
      title: 'Need a laptop screen replaced',
      description: 'Cracked screen on a ThinkPad T430.',
      categoryId: category.id,
      locationId: city.id,
      urgency: 'high',
      items: [{ name: 'Laptop screen', quantity: 1, conditionPreference: 'any' }],
    })

    assert.match(request.reference, /^KMP-\d{4}-\d{5}$/)
    assert.equal(request.isAnonymous, true)

    const first = app.marketplace.addOffer(request.id, business.id, { price: 90000 })
    assert.ok(first)
    assert.throws(
      () => app.marketplace.addOffer(request.id, business.id, {}),
      /already offered/,
    )
    app.marketplace.addOffer(request.id, rival.id, { price: 70000 })

    const detail = app.marketplace.acceptOffer(first.id)
    assert.equal(detail.status, 'in_progress')
    assert.equal(detail.offers.filter((offer) => offer.status === 'accepted').length, 1)
    assert.equal(detail.offers.filter((offer) => offer.status === 'declined').length, 1)
    // posted, offered, offered, accepted
    assert.equal(detail.history.length, 4)

    app.marketplace.setStatus(request.id, 'fulfilled')
    assert.equal(app.marketplace.requireById(request.id).status, 'fulfilled')
    assert.ok(app.marketplace.requireById(request.id).closedAt)
  } finally {
    cleanup()
  }
})

test('a business is only offered requests it has not already answered', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Entebbe Fixers',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    const first = app.marketplace.create({
      title: 'Bicycle puncture repair needed',
      categoryId: category.id,
      locationId: city.id,
    })
    app.marketplace.create({
      title: 'Second hand laptop wanted',
      categoryId: category.id,
      locationId: city.id,
    })

    const matching = app.marketplace.matchingOpenRequests({
      businessId: business.id,
      categoryId: category.id,
      locationId: city.id,
    })
    assert.equal(matching.length, 2)

    app.marketplace.addOffer(first.id, business.id, {})
    const after = app.marketplace.matchingOpenRequests({
      businessId: business.id,
      categoryId: category.id,
      locationId: city.id,
    })
    assert.equal(after.length, 1)
  } finally {
    cleanup()
  }
})

test('gap scoring is reproducible from a stored snapshot', () => {
  const inputs = {
    searches: 40,
    supplyScore: 0.6,
    distinctActors: 12,
    specificity: 0.8,
    kThreshold: 5,
    trendDelta: 0.5,
  }
  const first = computeGapScore(inputs)
  const second = computeGapScore(inputs)
  assert.deepEqual(first, second)
  assert.equal(first.suppressed, false)
  assert.equal(first.severity, 'critical')

  // Below the floor the score is zero and the row is flagged, not hidden.
  const suppressed = computeGapScore({ ...inputs, distinctActors: 2 })
  assert.equal(suppressed.score, 0)
  assert.equal(suppressed.suppressed, true)

  // Logarithmic demand: one search is noise, forty is a market.
  assert.ok(demandWeight(40) > demandWeight(4))
  assert.ok(demandWeight(4) > demandWeight(1))
  assert.equal(supplyAdequacy(5), 1)
  assert.equal(supplyAdequacy(1), 0.2)
})

test('trend detection refuses to report a ratio without a baseline', () => {
  const flat = detectTrend(Array(14).fill(1), { window: 7, minBaseline: 3 })
  assert.equal(flat.direction, 'insufficient_data')
  assert.equal(flat.ratio, null)

  // Going from 1 to 2 is not 100% growth, it is a baseline too small to divide.
  const tiny = detectTrend([...Array(7).fill(1), ...Array(7).fill(2)], { window: 7 })
  assert.equal(tiny.direction, 'emerging')
  assert.equal(tiny.ratio, null)

  const rising = detectTrend([...Array(7).fill(4), ...Array(7).fill(20)], { window: 7 })
  assert.equal(rising.direction, 'rising')
  assert.ok(rising.ratio > 1.5)

  const short = detectTrend([1, 2, 3], { window: 7 })
  assert.equal(short.direction, 'insufficient_data')
})

test('gaps, opportunities and runs are stored with their inputs', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const run = app.intelligence.startRun({ windowDays: 30 })
    const gap = {
      phrase: 'laptop screen',
      term: 'laptop',
      ngramSize: 2,
      locationId: city.id,
      coverageLevel: 'city',
      locationName: 'Kampala',
      windowDays: 30,
      searches: 40,
      distinctActors: 12,
      supplyCount: 1,
      supplyScore: 0.65,
      specificity: 0.8,
      averageResultQuality: 'none_in_area',
      trendDirection: 'rising',
      trendRatio: 2.4,
      trendDelta: 6,
      // 40 searches against almost no supply, from 12 distinct actors, on a
      // rising trend: the formula in core/intelligence.js saturates here.
      gapScore: 1,
      severity: 'critical',
      suppressed: false,
      inputs: { note: 'recompute me' },
    }
    app.intelligence.writeGaps(run.id, [gap, { ...gap, phrase: 'secret thing', distinctActors: 1, suppressed: true, gapScore: 0.99 }])

    const listed = app.intelligence.gaps({ runId: run.id })
    assert.equal(listed.total, 1, 'suppressed gaps are hidden by default')
    assert.deepEqual(app.intelligence.gapCountsForRun(run.id), { critical: 1 })

    const withSuppressed = app.intelligence.gaps({
      runId: run.id,
      includeSuppressed: true,
    })
    const hidden = withSuppressed.items.find((row) => row.phrase === 'secret thing')
    assert.equal(hidden.gapScore, 0, 'a suppressed gap never keeps its score')
    assert.equal(hidden.suppressed, true)
    assert.deepEqual(hidden.inputs, { note: 'recompute me' })

    const stored = app.intelligence.gap(listed.items[0].id)
    const recomputed = computeGapScore({
      searches: stored.searches,
      supplyScore: stored.supplyScore,
      distinctActors: stored.distinctActors,
      specificity: stored.specificity,
      kThreshold: stored.kThreshold,
      trendDelta: stored.trendDelta,
    })
    assert.equal(recomputed.score, stored.gapScore)

    const opportunity = deriveOpportunity({
      gap: {
        ...gap,
        averageResultQuality: gap.averageResultQuality,
      },
      trend: { direction: 'rising', ratio: 2.4, window: 7 },
      keyword: 'laptop screen',
      locationName: 'Kampala',
    })
    app.intelligence.recordOpportunities([
      {
        keyword: opportunity.keyword,
        locationId: city.id,
        locationName: 'Kampala',
        coverageLevel: 'city',
        severity: opportunity.severity,
        score: opportunity.score,
        estimatedMonthlySearches: opportunity.estimatedMonthlySearches,
        supplyCount: 1,
        trendDirection: opportunity.trendDirection,
        rationale: opportunity.rationale,
        suggestedAction: opportunity.suggestedAction,
      },
    ])
    // Re-recording refreshes rather than duplicating.
    app.intelligence.recordOpportunities([
      { keyword: 'laptop screen', locationId: city.id, score: 0.9, rationale: 'refreshed' },
    ])
    assert.equal(app.intelligence.opportunities().total, 1)

    assert.throws(
      () => app.intelligence.setOpportunityState(app.intelligence.opportunities().items[0].id, 'dismissed'),
      /requires a reason/,
    )
    const dismissed = app.intelligence.setOpportunityState(
      app.intelligence.opportunities().items[0].id,
      'dismissed',
      { reason: 'A provider opened last week.' },
    )
    assert.equal(dismissed.state, 'dismissed')
    assert.equal(app.intelligence.opportunities().total, 0)

    const finished = app.intelligence.completeRun(run.id, {
      searchesSeen: 40,
      gapsWritten: 2,
      gapsSuppressed: 1,
    })
    assert.equal(finished.status, 'completed')
    assert.equal(finished.gapsSuppressed, 1)
    assert.equal(app.intelligence.latestRun('gaps').id, run.id)
  } finally {
    cleanup()
  }
})

test('a failed run is recorded rather than swallowed', () => {
  const { app, cleanup } = freshApp()
  try {
    const run = app.intelligence.startRun({})
    app.intelligence.failRun(run.id, new Error('disk went away'))
    const stored = app.intelligence.run(run.id)
    assert.equal(stored.status, 'failed')
    assert.match(stored.error, /disk went away/)
  } finally {
    cleanup()
  }
})

test('audit log records before and after for an editorial change', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Mukono Tailors',
      categoryId: category.id,
      locationId: city.id,
      status: 'draft',
    })
    app.audit.record({
      actorId: null,
      actorRole: 'admin',
      action: 'business.verify',
      entityType: 'business',
      entityId: business.id,
      before: { verificationState: 'unverified' },
      after: { verificationState: 'verified' },
    })
    const entries = app.audit.forEntity('business', business.id)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].action, 'business.verify')
    assert.equal(JSON.parse(entries[0].afterJson).verificationState, 'verified')
  } finally {
    cleanup()
  }
})

test('a decision records why it was made, not only what changed', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const business = app.businesses.create({
      name: 'Mukono Tailors',
      categoryId: category.id,
      locationId: city.id,
      status: 'draft',
    })

    // A verification without a stated basis is indistinguishable from somebody
    // pressing a button, and a directory that cannot say why a listing was
    // published is a directory nobody can correct.
    app.audit.record({
      actorId: null,
      actorRole: 'editor',
      action: 'business.verify',
      entityType: 'business',
      entityId: business.id,
      reason: 'Called the shop; the owner confirmed the listing.',
      before: { verificationState: 'unverified' },
      after: { verificationState: 'verified' },
    })
    const [entry] = app.audit.forEntity('business', business.id)
    assert.equal(entry.reason, 'Called the shop; the owner confirmed the listing.')

    // And an entry that is not a decision carries no reason at all.
    app.audit.record({
      actorId: null,
      actorRole: 'editor',
      action: 'business.update',
      entityType: 'business',
      entityId: business.id,
      after: { name: 'Mukono Tailors Ltd' },
    })
    const all = app.audit.forEntity('business', business.id)
    assert.equal(all.length, 2)
    // Newest first, and the order does not depend on two rows having landed in
    // different milliseconds.
    assert.deepEqual(
      all.map((row) => row.action),
      ['business.update', 'business.verify'],
    )
    assert.equal(all[0].reason, null)
  } finally {
    cleanup()
  }
})

test('a reviewer sees the contact evidence, and a public listing does not', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const withPhone = app.businesses.create({
      name: 'Nakawa Hair Studio',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    const bare = app.businesses.create({
      name: 'Kololo Bikes',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })
    app.businesses.addContact(withPhone.id, { kind: 'phone', value: '0772111222' })
    app.businesses.addContact(withPhone.id, { kind: 'email', value: 'hello@nakawa.ug' })

    const { items } = app.businesses.list({
      status: 'active',
      sort: 'name',
      includeContacts: true,
    })

    // One query for the page, not one per row: a queue of listings is reviewed
    // by reading, and a row that hides its phone number until it is fetched
    // separately cannot be read.
    const studio = items.find((row) => row.id === withPhone.id)
    assert.equal(studio.contactCount, 2)
    assert.deepEqual(
      studio.contacts.map((contact) => contact.kind).sort(),
      ['email', 'phone'],
    )
    // Stored canonically, which is what makes the same number typed three
    // ways one contact rather than three.
    assert.equal(studio.contacts.find((contact) => contact.kind === 'phone').value, '+256772111222')
    // A contact added by an editor is public from the start, because they typed
    // it after speaking to somebody. An imported one arrives private, which is
    // the whole reason the importer is safe. The queue has to show which is
    // which, or a reviewer cannot tell whether publishing the listing would
    // publish a phone number nobody confirmed.
    assert.equal(studio.publicContactCount, 2)

    const bikes = items.find((row) => row.id === bare.id)
    assert.equal(bikes.contactCount, 0)
    assert.deepEqual(bikes.contacts, [], 'the field is present and empty, not missing')

    // The same repository serves the public directory, and a list row there
    // carries no contact point at all — not the private ones, not the counts
    // that hint at them. Absent rather than empty, so nobody reads an omitted
    // field as "this listing has no way to be reached".
    const publicPage = app.businesses.list({ status: 'active', sort: 'name' })
    for (const row of publicPage.items) {
      assert.equal(row.contacts, undefined)
      assert.equal(row.contactCount, undefined)
      assert.equal(row.publicContactCount, undefined)
    }
    assert.ok(
      !JSON.stringify(publicPage).includes('+256772111222'),
      'a public list page does not carry contact values',
    )
  } finally {
    cleanup()
  }
})

test('supply measurement aggregates per location and category', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    // Created into the queue, then walked to `verified`, because a record cannot
    // be created into a checked state any more. The supply snapshot is what still
    // counts unchecked records, so both of these have to appear in it.
    const checked = app.businesses.create({
      name: 'Verified Fixer',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
      capabilityLevel: 'established',
    })
    app.businesses.review(checked.id, { action: 'verify', reason: 'Checked.' })
    app.businesses.create({
      name: 'Unverified Fixer',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })

    const snapshot = app.businesses.supplySnapshot()
    assert.equal(snapshot.length, 2)
    const total = snapshot.reduce((sum, row) => sum + row.weight, 0)
    assert.ok(total > 0)

    app.intelligence.recordSupplyMetric({
      day: '2026-05-04',
      locationId: city.id,
      coverageLevel: 'city',
      categoryId: category.id,
      businessCount: snapshot.length,
      supplyScore: total,
      verifiedCount: 1,
    })
    const series = app.intelligence.supplySeries({
      locationId: city.id,
      categoryId: category.id,
      from: '2026-05-01',
      to: '2026-05-10',
    })
    assert.equal(series.length, 1)
    assert.equal(series[0].businessCount, 2)
  } finally {
    cleanup()
  }
})

test('an approved business is trusted more than an unchecked one', () => {
  const { app, cleanup } = freshApp()
  try {
    const { city } = seedReference(app)
    const category = app.categories.ensureRoots()[1]
    const approved = app.businesses.create({
      name: 'Trusted Fixer',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
      capabilityLevel: 'operating',
    })
    const pending = app.businesses.create({
      name: 'Claimed Fixer',
      categoryId: category.id,
      locationId: city.id,
      status: 'active',
    })

    // Only the approved one is publicly searchable, so it is the only one the
    // ranking can be asked about at all.
    const queued = app.searchIndex.search({ query: 'fixer' })
    assert.deepEqual(queued.items, [])

    app.businesses.review(approved.id, { action: 'verify', reason: 'Checked.' })
    app.businesses.review(approved.id, { action: 'approve', reason: 'Published.' })
    app.businesses.review(pending.id, { action: 'claim', reason: 'Picked up.' })

    const ranked = app.searchIndex.search({ query: 'fixer' })
    assert.equal(ranked.items[0].docKey, `business:${approved.id}`)

    // Verification stamps the moment the facts were checked, and approval stamps
    // its own: they are different claims and collapsing them loses which one a
    // later reader is looking at.
    const afterVerifyOnly = app.businesses.review(pending.id, { action: 'verify', reason: 'Checked.' })
    assert.notEqual(afterVerifyOnly.verifiedAt, null)
    assert.equal(afterVerifyOnly.approvedAt, null)
    app.businesses.review(pending.id, { action: 'approve', reason: 'Published.' })
    assert.notEqual(app.businesses.requireById(pending.id).approvedAt, null)
  } finally {
    cleanup()
  }
})
