import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Drives the two browser end-to-end passes the way they are only worth driving:
 * a real Chromium against a real server on a throwaway database.
 *
 * The provider pass needs the demonstration seed (36 businesses, one admin) to
 * mean anything, so this runner seeds a fresh temporary database for it. The
 * requests pass runs against an empty database, which is also what makes its
 * `empty state` and `list now shows one request` assertions mean anything.
 *
 * Prereqs: a Python 3 interpreter with the `playwright` package and a Chromium
 * browser installed (`pip install playwright && python -m playwright install
 * chromium`). Override the interpreter with KIP_E2E_PYTHON, the demo admin
 * credentials with KIP_DEMO_ADMIN_EMAIL / KIP_DEMO_ADMIN_PASSWORD.
 *
 * It lives in `scripts/` rather than `test/` on purpose: `node --test` discovers
 * every file under a `test` directory, and this runner is not a unit test.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const E2E_DIR = path.join(APP_ROOT, 'test', 'e2e')
const PYTHON = process.env.KIP_E2E_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const DEMO_EMAIL = process.env.KIP_DEMO_ADMIN_EMAIL || 'demo@example.com'
const DEMO_PASSWORD = process.env.KIP_DEMO_ADMIN_PASSWORD || 'demo-password-123'

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function runCycle(label, { script, seed }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kip-e2e-'))
  const port = await freePort()
  let server = null
  console.log(`\n[${label}] temporary database: ${dir}`)
  try {
    if (seed) {
      const seeded = spawnSync(process.execPath, ['scripts/seed-demo.js'], {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          KIP_DATA_DIR: dir,
          KIP_DEMO_ADMIN_EMAIL: DEMO_EMAIL,
          KIP_DEMO_ADMIN_PASSWORD: DEMO_PASSWORD,
        },
        encoding: 'utf8',
      })
      if (seeded.status !== 0) {
        throw new Error(`seed-demo.js exited ${seeded.status}: ${seeded.stdout}${seeded.stderr}`)
      }
      if (!existsSync(path.join(dir, 'kampala.db'))) {
        throw new Error('seed-demo.js finished without creating a database')
      }
    }

    server = spawn(process.execPath, ['src/server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, KIP_PORT: String(port), KIP_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let bootLog = ''
    server.stdout.on('data', (chunk) => (bootLog += chunk))
    server.stderr.on('data', (chunk) => (bootLog += chunk))

    if (!(await waitForServer(port))) {
      throw new Error(`server never listened on ${port}:\n${bootLog}`)
    }

    const pass = spawnSync(PYTHON, [path.join(E2E_DIR, script)], {
      cwd: E2E_DIR,
      env: {
        ...process.env,
        KIP_E2E_BASE: `http://127.0.0.1:${port}`,
        KIP_DEMO_ADMIN_EMAIL: DEMO_EMAIL,
        KIP_DEMO_ADMIN_PASSWORD: DEMO_PASSWORD,
      },
      stdio: 'inherit',
    })
    if (pass.status !== 0) {
      throw new Error(`${script} exited ${pass.status}`)
    }
    console.log(`[${label}] PASS`)
    return true
  } catch (error) {
    console.error(`[${label}] FAIL: ${error.message}`)
    return false
  } finally {
    await stop(server)
    // Let the child release the database file before removing the directory.
    await new Promise((resolve) => setTimeout(resolve, 250))
    rmSync(dir, { recursive: true, force: true })
  }
}

const cycles = [
  ['requests page', { script: 'e2e_requests.py', seed: false }],
  ['provider desk', { script: 'e2e_provider.py', seed: true }],
]

const results = []
for (const [label, spec] of cycles) {
  results.push({ label, ok: await runCycle(label, spec) })
}

const failed = results.filter((result) => !result.ok)
if (failed.length === 0) {
  console.log('\nE2E: all passes green')
  process.exit(0)
}
for (const result of failed) {
  console.error(`E2E FAIL: ${result.label}`)
}
process.exit(1)