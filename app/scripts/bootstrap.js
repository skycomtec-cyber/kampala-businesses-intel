#!/usr/bin/env node
/**
 * Everything a fresh installation needs, in one run.
 *
 * Schema, then reference data, then the first admin account. Each step is
 * idempotent, so this is also what `start` runs before it listens: an install
 * that was interrupted half way finishes itself on the next launch rather than
 * leaving the server up against a half-built database.
 *
 * KIP_ADMIN_EMAIL and KIP_ADMIN_PASSWORD are what the launcher sets. When they
 * are absent, no account is created and the message says so, because silently
 * inventing a password nobody was told about is worse than no account.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'

const log = (message) => process.stdout.write(`${message}\n`)

const config = loadConfig()
const app = openApp({ config })

try {
  const seeded = seedReferenceData(app, { config })
  const counts = app.locations.counts()
  const locationTotal = Object.values(counts).reduce((total, value) => total + value, 0)
  log(
    `Schema ready (${app.health().migrations} migrations). ` +
      `Reference data: ${locationTotal} locations, ${app.categories.all().length} categories, ` +
      `${app.skills.count()} skills` +
      `${seeded.skipped ? ' (seeding disabled).' : '.'}`,
  )

  const email = process.env.KIP_ADMIN_EMAIL
  const password = process.env.KIP_ADMIN_PASSWORD
  const existing = app.users.list()

  if (existing.length === 0) {
    if (email && password) {
      const user = app.users.create({
        email,
        password,
        displayName: process.env.KIP_ADMIN_NAME ?? email.split('@')[0],
        role: 'admin',
        status: 'active',
      })
      log(`Created the first admin account: ${user.email}. Change the password after signing in.`)
    } else {
      log(
        'No operator account exists yet. Create the first admin with:\n' +
          '  npm run create-admin -- --email you@example.com',
      )
    }
  } else {
    log(`${existing.length} operator account(s) already exist.`)
  }
} catch (error) {
  process.stderr.write(`Bootstrap failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
