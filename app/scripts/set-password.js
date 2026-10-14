#!/usr/bin/env node
/**
 * Sets a new password for an existing account.
 *
 * Where `create-admin` is the only way an account is born, this is the operator's
 * way to change one afterwards without knowing the current password. The reset
 * link exists for the person who has forgotten theirs; this exists for the
 * operator who is helping them, or for the admin changing their own password from
 * a place that has no browser.
 *
 * The answers arrive the same way `create-admin` collects them: `--email` or
 * `KIP_ADMIN_EMAIL` for the address, `KIP_ADMIN_PASSWORD` for the new password,
 * and `KIP_ADMIN_PASSWORD_CONFIRM` for the repeat. A password that is neither in
 * the environment, nor piped, nor typed at a hidden prompt is refused rather than
 * invented. As with `create-admin`, the password is never an argument.
 *
 * Every session of the account is destroyed afterwards. A password change is
 * exactly the moment a session someone else is holding stops being trustworthy,
 * so all of them go and the account signs in again with the new password.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { createReader } from '../src/core/prompt.js'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--email') options.email = argv[++index]
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

const envEmail = process.env.KIP_ADMIN_EMAIL
const envPassword = process.env.KIP_ADMIN_PASSWORD
const envConfirm = process.env.KIP_ADMIN_PASSWORD_CONFIRM

const config = loadConfig()
const app = openApp({ config })

let reader = null

try {
  const piped =
    options.email || envEmail || process.stdin.isTTY ? [] : await readStdinLines()
  reader = process.stdin.isTTY ? createReader() : null

  async function askFor(question, askOptions) {
    if (!reader) {
      throw new Error(
        `set-password needs an answer to "${question}" but has no terminal to ask on.\n` +
          'Pipe an email then a password, or run:\n' +
          '  KIP_ADMIN_EMAIL=you@example.com KIP_ADMIN_PASSWORD=... npm run set-password',
      )
    }
    return reader.ask(question, askOptions)
  }

  const email = (options.email ?? envEmail ?? piped[0] ?? (await askFor('Email: '))).trim()
  if (!email) throw new Error('An email address is required.')

  const password =
    envPassword ??
    piped[1] ??
    (await askFor(`New password (min ${config.auth.minPasswordLength} characters): `, {
      hidden: true,
    }))
  if (!password) throw new Error('A new password is required.')

  // The confirm is checked whenever one was supplied. When the password came
  // from the environment (the launcher path) the launcher sends a repeat as well,
  // so a typo is caught here rather than locking the operator out. A password
  // piped or typed is confirmed the same way.
  const confirm = envConfirm ?? piped[2] ?? (reader ? await askFor('Repeat password: ', { hidden: true }) : undefined)
  if (confirm !== undefined && password !== confirm) {
    throw new Error('The two passwords did not match. Nothing was changed.')
  }

  const user = app.users.findByEmail(email)
  if (!user) {
    // Naming the account that was typed is not enough to act on: the usual
    // mistake is an address that is nearly right, so the known ones are listed
    // too. This runs on the operator's own machine against their own database,
    // which is why printing the addresses is safe here and nowhere else.
    const known = app.users.list().map((row) => row.email)
    throw new Error(
      known.length === 0
        ? `No account exists with the email ${email}. There are no accounts at all yet; create the first one with "Create Admin Account".`
        : `No account exists with the email ${email}. Known account(s): ${known.join(', ')}.`,
    )
  }

  app.users.setPassword(user.id, password)
  app.sessions.destroyAllForUser(user.id)
  log(
    `Updated the password for ${user.email} (${user.role}). ` +
      'Every existing session for that account was signed out.',
  )
  if (user.role === 'admin') {
    const admins = app.users.list().filter((row) => row.role === 'admin')
    if (admins.length === 1) log('This is the only admin account. Keep its password somewhere safe.')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  reader?.close()
  app.close()
}
