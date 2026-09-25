#!/usr/bin/env node
/**
 * The process entry point.
 *
 * Deliberately small, because everything worth reading is somewhere else: config
 * in `src/config.js`, the database in `src/db`, the routes in `src/api`. What is
 * left here is the part that only exists at runtime.
 *
 *   - Bring the schema and the reference data up to date on the way up. A launcher
 *     that starts a server against a half-migrated database produces errors that
 *     look like application bugs, so `start` never has to remember to run a
 *     migration first.
 *   - Print the listening address on its own line. The Pinokio launcher reads that
 *     line to decide what to open in the browser.
 *   - Shut the database down cleanly. SQLite in WAL mode keeps recent writes in a
 *     side file, and a hard kill at the wrong moment leaves that behind.
 */

import process from 'node:process'
import { loadConfig } from './config.js'
import { openApp } from './db/index.js'
import { seedReferenceData } from './seed/index.js'
import { buildApi } from './api/index.js'

const config = loadConfig()
const app = openApp({ config })
seedReferenceData(app, { config })

const server = await buildApi({ app, config })
let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  server.log.info({ signal }, 'shutting down')
  try {
    await server.close()
    app.close()
  } catch (error) {
    server.log.error({ err: error }, 'shutdown failed')
    process.exitCode = 1
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).then(() => process.exit(process.exitCode ?? 0))
  })
}

// An unhandled rejection leaves the process in a state nobody can reason about, so
// it is a hard stop rather than a warning.
process.on('unhandledRejection', (reason) => {
  server.log.error({ err: reason }, 'unhandled rejection')
  shutdown('unhandledRejection').then(() => process.exit(1))
})

try {
  const address = await server.listen({ host: config.host, port: config.port })

  // Kept on single, unadorned lines so the launcher's url capture has exactly one
  // pattern to match, whatever else the structured logger prints around it.
  process.stdout.write(`\nKampala Intelligence Platform listening at ${address}\n`)
  process.stdout.write(`API base: ${address}${config.api.prefix}\n`)
  process.stdout.write(`Database: ${config.database.file}\n\n`)
} catch (error) {
  process.stderr.write(`Failed to start: ${error.message}\n`)
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `Port ${config.port} is already in use. Set KIP_PORT to a free port and start again.\n`,
    )
  }
  app.close()
  process.exit(1)
}
