#!/usr/bin/env node
/**
 * Takes a backup of the database, and says what is in it.
 *
 * This is the command a cron entry runs. It is safe to run while the server is
 * up: SQLite's online backup API reads through a consistent snapshot, so a search
 * landing mid-copy is neither lost nor half-copied. Nothing here takes a lock that
 * would stall a request.
 *
 * What it deliberately does not copy is in `src/db/backup.js`, along with the
 * reason: `cp kampala.db` produces a file that looks complete and is missing every
 * write since the last checkpoint.
 *
 * A backup nobody has checked is a hypothesis, so this verifies what it wrote:
 * SQLite's own integrity check, plus a checksum recorded next to the file. A later
 * `npm run restore` refuses a file that fails either.
 *
 * Usage:
 *   npm run backup                          -> <dataDir>/backups, keeping 14
 *   npm run backup -- --dir /mnt/backups    -> somewhere else
 *   npm run backup -- --keep 30
 *   npm run backup -- --date 2026-10-01T09:00:00Z   for a reproducible name
 *   npm run backup -- --verify              -> check what is there, write nothing
 *   npm run backup -- --list
 *   npm run backup -- --quiet
 */

import process from 'node:process'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import {
  createBackup,
  listBackups,
  verifyBackup,
} from '../src/db/backup.js'

const DEFAULT_KEEP = 14

function parseArgs(argv) {
  const args = {
    directory: null,
    keep: DEFAULT_KEEP,
    date: null,
    verify: false,
    list: false,
    quiet: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--dir') {
      args.directory = value
      index += 1
    } else if (flag === '--keep') {
      const parsed = Number.parseInt(value, 10)
      // Refused rather than clamped, because a `--keep 0` that silently became
      // "keep 14" would leave the operator believing the directory was empty.
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--keep needs a whole number of at least 1, not "${value}".`)
      }
      args.keep = parsed
      index += 1
    } else if (flag === '--date') {
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--date needs a timestamp, not "${value}".`)
      }
      args.date = parsed
      index += 1
    } else if (flag === '--verify') {
      args.verify = true
    } else if (flag === '--list') {
      args.list = true
    } else if (flag === '--quiet') {
      args.quiet = true
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }
  return args
}

const HELP = `Usage: npm run backup -- [options]

  --dir <path>    Where to write. Default: <dataDir>/backups
  --keep <n>      How many backups to retain, newest first. Default: ${DEFAULT_KEEP}
  --date <iso>    Timestamp for the filename. Default: now
  --verify        Check every backup found, write nothing
  --list          List the backups found
  --quiet         Print nothing on success

Runs safely while the server is up. Exits non-zero on failure, so a cron job
that stops taking backups says so rather than filling a directory with nothing.`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  const config = loadConfig()
  const directory = path.resolve(args.directory ?? path.join(config.dataDir, 'backups'))
  const log = (message) => {
    if (!args.quiet) process.stdout.write(`${message}\n`)
  }

  if (args.list) {
    const files = listBackups(directory)
    if (files.length === 0) {
      process.stdout.write(`No backups in ${directory}.\n`)
      return
    }
    for (const file of files) {
      const verified = verifyBackup(file)
      const size = (verified.manifest?.bytes ?? 0) / 1024
      const state =
        verified.integrity.length === 1 && verified.integrity[0] === 'ok'
          ? verified.checksum === null
            ? 'ok (no manifest)'
            : verified.checksum.matches
              ? 'ok'
              : 'CHECKSUM MISMATCH'
          : 'INTEGRITY FAILED'
      process.stdout.write(`${state.padEnd(20)} ${new Date(verified.manifest?.createdAt ?? 0).toISOString()}  ${size.toFixed(0).padStart(8)} KiB  ${file}\n`)
    }
    return
  }

  if (args.verify) {
    const files = listBackups(directory)
    if (files.length === 0) {
      process.stdout.write(`No backups in ${directory}. Nothing to verify.\n`)
      return
    }
    let bad = 0
    for (const file of files) {
      const verified = verifyBackup(file)
      const integrity = verified.integrity.length === 1 && verified.integrity[0] === 'ok'
      const checksum = verified.checksum === null || verified.checksum.matches
      if (integrity && checksum) {
        log(`ok    ${file}`)
      } else {
        bad += 1
        process.stderr.write(
          `FAILED ${file}: ${integrity ? 'checksum does not match the manifest' : verified.integrity.join('; ')}\n`,
        )
      }
    }
    log(`\n${files.length - bad} of ${files.length} backup(s) are sound.`)
    if (bad > 0) process.exitCode = 1
    return
  }

  const app = openApp({ config })
  try {
    const result = await createBackup(app.db, {
      directory,
      date: args.date,
      keep: args.keep,
      kThreshold: config.privacy.kThreshold,
    })

    log(`Backup written: ${result.file}`)
    log(`  ${result.manifest.bytes} bytes, sha256 ${result.manifest.sha256.slice(0, 16)}...`)
    log(`  Schema at backup: ${result.manifest.migrations.length} migration(s)`)
    const counted = Object.entries(result.manifest.counts).filter(
      ([, value]) => typeof value === 'number' && value > 0,
    )
    log(
      `  Contents: ${counted.map(([table, value]) => `${value} ${table}`).join(', ') || 'nothing yet'}`,
    )
    if (result.manifest.kThreshold !== null) {
      log(`  k-anonymity floor in force when measured: ${result.manifest.kThreshold}`)
    }
    if (result.pruned.length > 0) {
      log(
        `  Pruned ${result.pruned.length} older backup(s) to keep ${args.keep}: ` +
          result.pruned.map((file) => path.basename(file)).join(', '),
      )
    }
    // Verify what was written, before reporting success. A backup command that
    // says "done" and cannot say whether the file is usable is the failure mode
    // this whole file exists to avoid.
    const verified = verifyBackup(result.file)
    const integrity = verified.integrity.length === 1 && verified.integrity[0] === 'ok'
    if (!integrity) {
      throw new Error(
        `The backup just written failed its integrity check: ${verified.integrity.join('; ')}`,
      )
    }
    log('  Verified: integrity check passed.')
  } finally {
    app.close()
  }
}

main().catch((error) => {
  process.stderr.write(`Backup failed: ${error.message}\n`)
  process.exitCode = 1
})