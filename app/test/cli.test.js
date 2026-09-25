import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const createAdmin = path.join(appRoot, 'scripts', 'create-admin.js')
const password = 'Kampala-Reference-2026'

/**
 * A throwaway data directory with the schema already in place, which is the
 * state create-admin.js expects: openApp migrates, the account script only
 * assumes the database is there.
 */
function freshDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-cli-'))
  withDataDir(dataDir, () => {
    openApp({ config: loadConfig() }).close()
  })
  return dataDir
}

/** Swaps KIP_DATA_DIR for the duration of a call, the way the scripts read it. */
function withDataDir(dataDir, callback) {
  const previous = process.env.KIP_DATA_DIR
  process.env.KIP_DATA_DIR = dataDir
  try {
    return callback()
  } finally {
    if (previous === undefined) delete process.env.KIP_DATA_DIR
    else process.env.KIP_DATA_DIR = previous
  }
}

function run(args, { dataDir, env = {}, stdin = 'ignore' }) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [createAdmin, ...args],
      { env: { ...process.env, KIP_DATA_DIR: dataDir, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
    child.stdin.end(stdin === 'ignore' ? undefined : stdin)
  })
}

function readAccounts(dataDir) {
  return withDataDir(dataDir, () => {
    const app = openApp({ config: loadConfig() })
    const users = app.users.list()
    app.close()
    return users
  })
}

test('create-admin takes a password from the environment when a launcher supplies one', async () => {
  const dataDir = freshDataDir()
  try {
    const result = await run(['--email', 'operator@kampala.test'], {
      dataDir,
      env: { KIP_ADMIN_PASSWORD: password },
    })
    assert.equal(result.code, 0, result.stderr)
    const [user] = readAccounts(dataDir)
    assert.equal(user.email, 'operator@kampala.test')
    assert.equal(user.role, 'admin')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('create-admin takes both answers from piped stdin', async () => {
  const dataDir = freshDataDir()
  try {
    const result = await run([], {
      dataDir,
      stdin: 'piped@kampala.test\nKampala-Reference-2026\n',
    })
    assert.equal(result.code, 0, result.stderr)
    const [user] = readAccounts(dataDir)
    assert.equal(user.email, 'piped@kampala.test')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('create-admin explains itself when there is no terminal and nothing piped', async () => {
  // The case that used to hang: a launcher step with no input, no env, no TTY.
  // A question on a closed stdin is never answered, and node exits with an
  // unsettled top-level await instead of a message anyone can act on.
  const dataDir = freshDataDir()
  try {
    const result = await run([], { dataDir })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /no terminal to ask on/)
    assert.match(result.stderr, /KIP_ADMIN_PASSWORD/)
    assert.equal(readAccounts(dataDir).length, 0)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('create-admin refuses a piped email with no password anywhere', async () => {
  const dataDir = freshDataDir()
  try {
    const result = await run([], { dataDir, stdin: 'half@kampala.test\n' })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Password \(min \d+ characters\)/)
    assert.equal(readAccounts(dataDir).length, 0)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('create-admin refuses a second account without being told whose', async () => {
  const dataDir = freshDataDir()
  try {
    const first = await run(['--email', 'owner@kampala.test'], {
      dataDir,
      env: { KIP_ADMIN_PASSWORD: password },
    })
    assert.equal(first.code, 0, first.stderr)

    // Ambiguous on purpose: adding a second admin is plausible, so the script
    // has to be told rather than assume.
    const second = await run([], { dataDir, env: { KIP_ADMIN_PASSWORD: password } })
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /--email you@example.com/)
    assert.equal(readAccounts(dataDir).length, 1)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
