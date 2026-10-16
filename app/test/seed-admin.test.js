import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedAdmin } from '../src/seed/index.js'

/**
 * The first operator on a platform with no shell.
 *
 * A free PaaS tier cannot run `npm run create-admin`, so the only way a first
 * account can appear there is from the environment the deploy already carries.
 * That makes three promises worth testing, in the order they matter:
 *
 *   - an environment naming email and password gets a working admin account
 *   - an environment naming nothing creates nothing (and says why)
 *   - an install that already has an account is never touched, so a password
 *     left in the environment afterwards cannot reset a real operator
 */

function freshApp(admin = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-seed-admin-'))
  const previous = {
    KIP_ADMIN_EMAIL: process.env.KIP_ADMIN_EMAIL,
    KIP_ADMIN_PASSWORD: process.env.KIP_ADMIN_PASSWORD,
    KIP_ADMIN_NAME: process.env.KIP_ADMIN_NAME,
  }
  // The config reads these at load, so they are applied before loadConfig and
  // restored after, the same shape the other config-driven tests use.
  for (const [key, value] of Object.entries({
    KIP_ADMIN_EMAIL: admin.email,
    KIP_ADMIN_PASSWORD: admin.password,
    KIP_ADMIN_NAME: admin.name,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'test.db') })
    const app = openApp({ config })
    return {
      app,
      config,
      cleanup() {
        app.close()
        fs.rmSync(dir, { recursive: true, force: true })
      },
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const STRONG = 'a-Long-unguessable-1pass'
const ALSO_STRONG = 'a-Different-strong-pass2'

test('an environment naming an operator gets a working admin account', () => {
  const ctx = freshApp({ email: 'owner@example.com', password: STRONG, name: 'Owner' })
  try {
    const result = seedAdmin(ctx.app, { config: ctx.config })

    assert.equal(result.created, true, 'the account is created')
    assert.equal(result.email, 'owner@example.com')

    const users = ctx.app.users.list()
    assert.equal(users.length, 1)
    assert.equal(users[0].role, 'admin')
    assert.equal(users[0].displayName, 'Owner')

    // The point of the account is signing in, so prove the password actually works
    // rather than only that a row exists.
    const signedIn = ctx.app.users.authenticate('owner@example.com', STRONG)
    assert.ok(signedIn, 'the seeded password authenticates')
    assert.equal(signedIn.role, 'admin')
  } finally {
    ctx.cleanup()
  }
})

test('an environment naming no operator creates nothing', () => {
  const ctx = freshApp({})
  try {
    const result = seedAdmin(ctx.app, { config: ctx.config })

    assert.equal(result.created, false)
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'not-configured')
    assert.equal(ctx.app.users.list().length, 0, 'no account is invented')
  } finally {
    ctx.cleanup()
  }
})

test('an install that already has an account is never touched', () => {
  const ctx = freshApp({ email: 'first@example.com', password: STRONG })
  try {
    seedAdmin(ctx.app, { config: ctx.config })

    // A second pass with a *different* credential in the environment must not
    // replace or reset the real operator, which is what would happen if the gate
    // were "is the env set" rather than "is there an account yet".
    ctx.config.admin.email = 'intruder@example.com'
    ctx.config.admin.password = ALSO_STRONG
    const second = seedAdmin(ctx.app, { config: ctx.config })

    assert.equal(second.created, false)
    assert.equal(second.reason, 'exists')
    assert.equal(ctx.app.users.list().length, 1, 'still exactly one account')

    // The original password still works, the intruder's does not.
    assert.ok(ctx.app.users.authenticate('first@example.com', STRONG))
    assert.equal(ctx.app.users.authenticate('intruder@example.com', ALSO_STRONG), null)
  } finally {
    ctx.cleanup()
  }
})

test('a display name is derived from the email when none is given', () => {
  const ctx = freshApp({ email: 'operator@example.com', password: STRONG })
  try {
    seedAdmin(ctx.app, { config: ctx.config })
    assert.equal(ctx.app.users.list()[0].displayName, 'operator')
  } finally {
    ctx.cleanup()
  }
})

test('a weak password in the environment is reported, not thrown', () => {
  // A password that fails the strength rule must not crash the server at boot:
  // the platform would never go green and the operator would see only a failed
  // deploy. It is reported, the service still comes up, and the account can be
  // made another way.
  const ctx = freshApp({ email: 'weak@example.com', password: 'tooshort' })
  try {
    const result = seedAdmin(ctx.app, { config: ctx.config })

    assert.equal(result.created, false)
    assert.equal(result.reason, 'invalid')
    assert.match(result.message, /password/i, 'the reason names the password rule')
    assert.equal(ctx.app.users.list().length, 0, 'no half-made account is left behind')
  } finally {
    ctx.cleanup()
  }
})
