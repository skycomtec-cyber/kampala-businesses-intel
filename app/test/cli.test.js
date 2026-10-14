import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createReader, recorder, fakeTerminal } from '../src/core/prompt.js'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const createAdmin = path.join(appRoot, 'scripts', 'create-admin.js')
const setPassword = path.join(appRoot, 'scripts', 'set-password.js')
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

function runCli(script, args, { dataDir, env = {}, stdin = 'ignore' }) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
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

function run(args, options) {
  return runCli(createAdmin, args, options)
}

function runSetPassword(args, options) {
  return runCli(setPassword, args, options)
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

test('create-admin takes both answers from the environment when a launcher supplies them', async () => {
  // The launcher collects the email and password with Pinokio's `input` API and
  // hands them over through the environment, so the CLI never touches the shell
  // or stdin. This is the exact shape of that call.
  const dataDir = freshDataDir()
  try {
    const result = await run([], {
      dataDir,
      env: { KIP_ADMIN_EMAIL: 'launcher@kampala.test', KIP_ADMIN_PASSWORD: password },
    })
    assert.equal(result.code, 0, result.stderr)
    const [user] = readAccounts(dataDir)
    assert.equal(user.email, 'launcher@kampala.test')
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

/*
 * set-password is the browser-free way to change a password: the operator who
 * has lost theirs cannot supply the current one, so it takes only the email and
 * the new password. The repeat is checked whenever it is supplied, because a
 * typo here is the one way to lock everybody out of the only admin account.
 */

test('set-password changes an existing account and refuses a mismatched repeat', async () => {
  const dataDir = freshDataDir()
  try {
    const created = await run(['--email', 'owner@kampala.test'], {
      dataDir,
      env: { KIP_ADMIN_PASSWORD: password },
    })
    assert.equal(created.code, 0, created.stderr)

    // A mismatch changes nothing, so a typo cannot lock the operator out.
    const mismatch = await runSetPassword([], {
      dataDir,
      env: {
        KIP_ADMIN_EMAIL: 'owner@kampala.test',
        KIP_ADMIN_PASSWORD: 'changed-password-12',
        KIP_ADMIN_PASSWORD_CONFIRM: 'typo-password-999',
      },
    })
    assert.notEqual(mismatch.code, 0)
    assert.match(mismatch.stderr, /did not match/)

    const changed = await runSetPassword([], {
      dataDir,
      env: {
        KIP_ADMIN_EMAIL: 'owner@kampala.test',
        KIP_ADMIN_PASSWORD: 'changed-password-12',
        KIP_ADMIN_PASSWORD_CONFIRM: 'changed-password-12',
      },
    })
    assert.equal(changed.code, 0, changed.stderr)

    withDataDir(dataDir, () => {
      const app = openApp({ config: loadConfig() })
      // The old password is gone and the new one works.
      assert.equal(app.users.authenticate('owner@kampala.test', password), null)
      assert.ok(app.users.authenticate('owner@kampala.test', 'changed-password-12'))
      app.close()
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('set-password refuses an account that does not exist', async () => {
  const dataDir = freshDataDir()
  try {
    const result = await runSetPassword([], {
      dataDir,
      env: { KIP_ADMIN_EMAIL: 'nobody@kampala.test', KIP_ADMIN_PASSWORD: password },
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /No account exists/)
    assert.equal(readAccounts(dataDir).length, 0)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('set-password signs every existing session out, because they are no longer trustworthy', async () => {
  const dataDir = freshDataDir()
  try {
    const created = await run(['--email', 'owner@kampala.test'], {
      dataDir,
      env: { KIP_ADMIN_PASSWORD: password },
    })
    assert.equal(created.code, 0, created.stderr)

    // A session taken out before the change - as if signed in elsewhere.
    const lived = withDataDir(dataDir, () => {
      const app = openApp({ config: loadConfig() })
      const owner = app.users.authenticate('owner@kampala.test', password)
      const session = app.sessions.create({ userId: owner.id })
      app.close()
      return session.token
    })

    const changed = await runSetPassword([], {
      dataDir,
      env: {
        KIP_ADMIN_EMAIL: 'owner@kampala.test',
        KIP_ADMIN_PASSWORD: password,
        KIP_ADMIN_PASSWORD_CONFIRM: password,
      },
    })
    assert.equal(changed.code, 0, changed.stderr)

    withDataDir(dataDir, () => {
      const app = openApp({ config: loadConfig() })
      assert.equal(app.sessions.resolve(lived), null)
      app.close()
    })
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

/*
 * The interactive prompt, driven through a stand-in for a terminal.
 *
 * This exists because of a hang that no amount of API testing could have found.
 * Pinokio's browser terminals are a JavaScript PTY, and a PTY bridge is free to
 * deliver Enter as LF where a real terminal sends CR. The old prompt was built
 * on readline's private `_writeToOutput`, and under that terminal the line
 * refresh was swallowed by the echo muter, so the password prompt looked frozen
 * while the process waited for input nobody could see was still wanted. Reading
 * the terminal directly is the fix; these cases are what hold it in place.
 */

const ENTER = { cr: '\r', lf: '\n' }

for (const [name, eol] of Object.entries(ENTER)) {
  test(`the password prompt accepts a line ended with ${name.toUpperCase()}`, async () => {
    const input = fakeTerminal()
    const out = recorder()
    const reader = createReader(input, out)

    const answer = reader.ask('Password: ', { hidden: true })
    input.write(`Kampala-Reference-2026${eol}`)

    assert.equal(await answer, 'Kampala-Reference-2026')
    reader.close()
  })
}

test('a hidden prompt never echoes what is typed', async () => {
  const input = fakeTerminal()
  const out = recorder()
  const reader = createReader(input, out)

  const answer = reader.ask('Password: ', { hidden: true })
  input.write('hunter2-hunter2')

  // Nothing is drawn while the characters are being typed.
  assert.equal(out.text(), 'Password: ')

  input.write('\r')
  assert.equal(await answer, 'hunter2-hunter2')
  assert.equal(out.text(), 'Password: \n')
  reader.close()
})

test('a visible prompt echoes what is typed', async () => {
  const input = fakeTerminal()
  const out = recorder()
  const reader = createReader(input, out)

  const answer = reader.ask('Email: ')
  input.write('ops@kampala.test')
  assert.equal(out.text(), 'Email: ops@kampala.test')

  input.write('\r')
  assert.equal(await answer, 'ops@kampala.test')
  reader.close()
})

for (const [name, key] of Object.entries({ backspace: '\b', delete: '\u007f' })) {
  test(`${name} removes a character instead of becoming part of the answer`, async () => {
    const input = fakeTerminal()
    const out = recorder()
    const reader = createReader(input, out)

    const answer = reader.ask('Email: ')
    input.write(`ops@kampala.testX${key}Y\r`)
    assert.equal(await answer, 'ops@kampala.testY')
    reader.close()
  })
}

test('the prompt takes the terminal out of raw mode and lets go of it', async () => {
  const input = fakeTerminal()
  const reader = createReader(input, recorder())

  const answer = reader.ask('Email: ')
  input.write('ops@kampala.test\r')
  await answer

  // Left in raw mode, node would not exit: stdin keeps the event loop alive.
  assert.equal(input.rawMode(), false)
  assert.equal(input.listenerCount('data'), 0)
  reader.close()
})

test('Ctrl+C at the password prompt gives up rather than storing the line', async () => {
  const input = fakeTerminal()
  const reader = createReader(input, recorder())

  const answer = reader.ask('Password: ', { hidden: true })
  input.write('half-typed-secret\u0003')

  await assert.rejects(answer, /Cancelled/)
  reader.close()
})
