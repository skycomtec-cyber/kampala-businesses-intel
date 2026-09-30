import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'

/**
 * The demonstration seeder must not be able to touch a real install.
 *
 * The seeder writes invented traders. If it can be pointed at the real database by
 * a forgotten environment variable, a mistyped path, or a database-file override
 * that outranks the data directory, then it is a way to put false businesses into
 * somebody's directory, and the damage is the kind nobody notices for months. These
 * tests are the only thing standing between a demonstration and a real one, so they
 * are worth more than their line count suggests.
 *
 * Every case here is a refusal - a non-zero exit and a message explaining what to do
 * instead - rather than a warning, and the database is checked afterwards to prove
 * the refusal happened before anything was written. That ordering is the whole
 * point: a script that prints a warning and then writes anyway has not refused.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const SEED_DEMO = path.join(APP_ROOT, 'scripts', 'seed-demo.js')
const REAL_DATA_DIR = path.join(APP_ROOT, 'data')
const REAL_DB = path.join(REAL_DATA_DIR, 'kampala.db')

function runSeeder(env, args = []) {
  const result = spawnSync(process.execPath, [SEED_DEMO, ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, KIP_DATA_DIR: undefined, KIP_DB_FILE: undefined, ...env },
    encoding: 'utf8',
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** Any leaf category and any district, the two things a business cannot lack. */
function leafCategory(app) {
  for (const root of app.categories.ensureRoots()) {
    for (const branch of app.categories.children(root.id)) {
      return app.categories.children(branch.id)[0] ?? branch
    }
  }
  throw new Error('the reference dataset has no categories')
}

/**
 * Any district, which lives two levels below the country root.
 *
 * Asked for by kind rather than by walking the tree, because the tree is
 * country -> region -> district -> division, and a walk that hardcodes that depth
 * breaks the day a municipality is inserted directly under the root.
 */
function anyDistrict(app) {
  const { items } = app.locations.listByKind('district', {})
  if (!items?.length) throw new Error('the reference dataset has no districts')
  return items[0]
}

/** A configured, reference-seeded database in a temp directory. */
function tempApp(dir) {
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'kampala.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  return { app, config }
}

/**
 * A database file that already holds one business, standing in for a real install.
 *
 * Created in whatever intake state the core allows, which is the point of the core
 * refusing anything else: a record cannot be born published. Approval is irrelevant
 * here because the guards under test count rows rather than read their state, and
 * creating an approved row would mean routing through review for no gain.
 */
function populatedDb(dir) {
  const { app } = tempApp(dir)
  try {
    app.businesses.create({
      categoryId: leafCategory(app).id,
      locationId: anyDistrict(app).id,
      sourceId: 'source:real',
      name: 'A Real Business',
    })
  } finally {
    app.close()
  }
  return path.join(dir, 'kampala.db')
}

test('refuses when KIP_DATA_DIR is unset', () => {
  const { status, output } = runSeeder({ KIP_DATA_DIR: undefined })
  assert.equal(status, 1)
  assert.match(output, /Refusing to run: KIP_DATA_DIR is not set/)
  assert.match(output, /data-demo/, 'and says where the demonstration does belong')
})

test('refuses when KIP_DATA_DIR is the real install', () => {
  const { status, output } = runSeeder({ KIP_DATA_DIR: REAL_DATA_DIR })
  assert.equal(status, 1)
  assert.match(output, /Refusing to run: KIP_DATA_DIR is the real install's data directory/)
})

test('refuses a relative KIP_DATA_DIR that resolves back to the real install', () => {
  // From the app root, `data` is the real install. The guard has to resolve before
  // it compares, or a relative path walks straight past it.
  const { status, output } = runSeeder({ KIP_DATA_DIR: 'data' })
  assert.equal(status, 1)
  assert.match(output, /Refusing to run/)
})

test('refuses when KIP_DB_FILE overrides the database away from the demo directory', () => {
  // The case that made the directory check insufficient. `loadConfig` reads
  // KIP_DB_FILE ahead of `<dataDir>/kampala.db`, so a data directory of its own is
  // not enough: an operator who had pointed KIP_DB_FILE at a real database would
  // otherwise have had the demonstration written into it, with a guard in front
  // that had already passed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-demo-guard-'))
  const realDb = populatedDb(dir)
  try {
    const { status, output } = runSeeder({
      KIP_DATA_DIR: path.join(dir, 'demo'),
      KIP_DB_FILE: realDb,
    })
    assert.equal(status, 1)
    assert.match(output, /Refusing to run: the database file .* is outside the demonstration directory/)
    assert.match(output, /KIP_DB_FILE/, 'and names the variable to unset')

    const config = loadConfig({ dataDir: dir, databaseFile: realDb })
    const app = openApp({ config })
    try {
      const rows = app.db.prepare('SELECT COUNT(*) AS n FROM business').get()
      assert.equal(rows.n, 1, 'the real database still holds only its own one business')
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses to run twice, so the dataset cannot be built on top of itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-demo-guard-'))
  try {
    // `kampala.db` and not something else, because that is the name the seeder
    // resolves for itself from the data directory. A test that wrote its fixture to
    // a different filename would be asserting against a database the seeder never
    // opens, and the guard would look perfectly empty.
    const databaseFile = path.join(dir, 'kampala.db')
    const config = loadConfig({ dataDir: dir, databaseFile })
    const app = openApp({ config })
    try {
      seedReferenceData(app, { config })
      // One business with the demonstration's own source id, which is what a
      // previously built demonstration would contain. A guard that only rejected
      // *non*-demonstration content would wave this through and double the dataset.
      app.businesses.create({
        categoryId: leafCategory(app).id,
        locationId: anyDistrict(app).id,
        sourceId: 'seed:demo',
        name: 'A Demonstration Business',
      })
    } finally {
      app.close()
    }

    const { status, output } = runSeeder({ KIP_DATA_DIR: dir })
    assert.equal(status, 1)
    assert.match(output, /Refusing to run: that database already holds 1 business record/)

    const after = openApp({ config })
    try {
      const rows = after.db.prepare('SELECT COUNT(*) AS n FROM business').get()
      assert.equal(rows.n, 1, 'and it did not add anything')
    } finally {
      after.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--help explains the guard instead of building anything', () => {
  // `--help` is an argument, and it has to be, because the point of the flag is to
  // work in the one situation the guard refuses: an operator who has not set
  // anything yet and needs to be told where the demonstration belongs.
  const { status, output } = runSeeder({ KIP_DATA_DIR: undefined }, ['--help'])
  assert.equal(status, 0)
  assert.match(output, /demonstration database belongs here/i)
})
