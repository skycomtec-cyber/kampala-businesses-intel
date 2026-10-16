import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { createHarvestScheduler } from '../src/harvest/inprocess.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kip-harvest-sched-'))
}

function configWith(dataDir, harvest = {}) {
  const base = loadConfig({ dataDir })
  return {
    ...base,
    harvest: {
      ...base.harvest,
      schedule: false,
      plansDir: base.harvest.plansDir,
      archiveDir: base.harvest.archiveDir,
      ...harvest,
    },
  }
}

test('disabled harvest scheduler does nothing', async () => {
  const dataDir = tempDir()
  try {
    const app = openApp({ config: loadConfig({ dataDir }) })
    try {
      const config = configWith(dataDir, { schedule: false })
      const scheduler = createHarvestScheduler(app, config, { logger: () => {} })
      const result = await scheduler.checkNow()
      assert.equal(result.skipped, true)
      assert.equal(result.reason, 'disabled')
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('enabled scheduler reports when no cadenced plans are due', async () => {
  const dataDir = tempDir()
  try {
    const app = openApp({ config: loadConfig({ dataDir }) })
    try {
      const config = configWith(dataDir, { schedule: true })
      const scheduler = createHarvestScheduler(app, config, {
        logger: () => {},
        now: () => new Date(),
      })
      const result = await scheduler.runOnce()
      assert.ok(!result.skipped)
      assert.equal(typeof result.discovered, 'number')
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('concurrency guard prevents overlapping runs', async () => {
  const dataDir = tempDir()
  try {
    const app = openApp({ config: loadConfig({ dataDir }) })
    try {
      const config = configWith(dataDir, { schedule: true })
      const scheduler = createHarvestScheduler(app, config, { logger: () => {} })
      const first = scheduler.runOnce()
      const second = scheduler.runOnce()
      const [r1, r2] = await Promise.all([first, second])
      assert.equal(r2.skipped, true)
      assert.equal(r2.reason, 'already-running')
      assert.ok(!r1.skipped)
    } finally {
      app.close()
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
