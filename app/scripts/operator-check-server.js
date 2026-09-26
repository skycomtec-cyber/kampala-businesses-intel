/**
 * A throwaway server for the operator UI check.
 *
 * Fresh data directory, an admin account, and the catalogue seed, on a port
 * picked for this run so it cannot collide with anything already listening.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData, seedCatalogue } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-operator-'))
const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'ui.db') })
const app = openApp({ config })
seedReferenceData(app, { config })
seedCatalogue(app, { config })
app.users.create({
  email: 'admin@kampala.test',
  password: 'Kampala-Reference-2026',
  displayName: 'Phase Two Operator',
  role: 'admin',
})
const server = await buildApi({ app, config })
await server.listen({ port: 4319, host: '127.0.0.1' })
console.log('ready on 4319')
