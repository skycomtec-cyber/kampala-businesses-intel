#!/usr/bin/env node
/**
 * Creates an operator account.
 *
 * There is no public registration in this platform, on purpose: a directory of
 * Kampala businesses that let anybody sign themselves up would collect exactly the
 * kind of data it exists not to collect. Every account is created here, by
 * somebody with shell access, which is a far higher bar than an email form.
 *
 * The password comes from KIP_ADMIN_PASSWORD, or from the first line of stdin, or
 * from a prompt with echo switched off. It is never accepted as an argument,
 * because an argument is visible in the process table and lands in shell history.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { assertRole } from '../src/core/auth.js'
import { createReader } from '../src/core/prompt.js'

function parseArgs(argv) {
  const options = { role: 'admin' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--email') options.email = argv[++index]
    else if (arg === '--role') options.role = argv[++index]
    else if (arg === '--display-name') options.displayName = argv[++index]
    else if (arg === '--quiet') options.quiet = true
  }
  return options
}

/** Piped input, so a launcher step can feed answers in without a terminal. */
function readStdinLines() {
  if (process.stdin.isTTY) return Promise.resolve([])
  return new Promise((resolve) => {
    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
    })
    process.stdin.on('end', () => {
      resolve(buffer.split(/\r?\n/).filter((line) => line.length > 0))
    })
    process.stdin.on('error', () => resolve([]))
  })
}

const options = parseArgs(process.argv.slice(2))
const log = (message) => {
  if (!options.quiet) process.stdout.write(`${message}\n`)
}

const config = loadConfig()
const app = openApp({ config })

try {
  const role = assertRole(options.role)

  if (app.users.list().length === 0) {
    log('No accounts exist yet. The first one is an admin.')
  } else if (!options.email) {
    log(
      'Accounts already exist. Create another with:\n' +
        '  npm run create-admin -- --email you@example.com [--role editor]',
    )
    process.exit(0)
  }

  // Exactly one thing may own stdin. Reading piped input and the interactive
  // prompt attached at the same time split the input between them, and the
  // account then gets created with half an email address.
  const piped = options.email || process.stdin.isTTY ? [] : await readStdinLines()
  const suppliedPassword = process.env.KIP_ADMIN_PASSWORD ?? piped[1]
  const reader = process.stdin.isTTY ? createReader() : null

  async function askFor(question, askOptions) {
    if (!reader) {
      throw new Error(
        `create-admin needs an answer to "${question}" but has no terminal to ask on.\n` +
          'Pipe an email then a password, or run:\n' +
          '  KIP_ADMIN_PASSWORD=... npm run create-admin -- --email you@example.com',
      )
    }
    return reader.ask(question, askOptions)
  }

  const email = (options.email ?? piped[0] ?? (await askFor('Email: '))).trim()
  const password =
    suppliedPassword ??
    (await askFor(`Password (min ${config.auth.minPasswordLength} characters): `, {
      hidden: true,
    }))

  if (!email || !password) {
    throw new Error('An email address and a password are both required.')
  }
  if (suppliedPassword === undefined) {
    // The password was typed at a prompt, so it gets confirmed. A password that
    // arrived from the environment or from a pipe is taken as given.
    const confirm = (await askFor('Repeat password: ', { hidden: true })).trim()
    if (password !== confirm) throw new Error('The two passwords did not match.')
  }
  reader?.close()

  const user = app.users.create({
    email,
    password,
    displayName: options.displayName ?? email.split('@')[0],
    role,
    status: 'active',
  })

  log(`Created ${user.role} account ${user.email} (${user.id}).`)
  if (role === 'admin' && app.users.list().filter((row) => row.role === 'admin').length === 1) {
    log('This is the only admin account. Keep its password somewhere safe.')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
