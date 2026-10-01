#!/usr/bin/env node
/**
 * Puts a backup back, in a way that can be undone.
 *
 * The safety properties, in the order they are enforced:
 *
 *   1. It refuses while a server is holding the data directory. Replacing the file
 *      under a live process is the one failure that looks like success: on Linux the
 *      rename succeeds, the running server keeps its handle to the old inode, and
 *      the platform reports a restored database while serving one that is no longer
 *      on disk.
 *   2. It verifies the backup before it touches anything, so a corrupt file is found
 *      before it has cost the good database.
 *   3. It moves the current database aside instead of deleting it, and prints where
 *      it went. A restore that cannot be reversed is not recovery.
 *   4. It deletes the session secret, so no session that predates the restore is
 *      still valid afterwards. That costs one re-login per operator and is the
 *      right direction after an incident.
 *
 * Usage:
 *   npm run restore -- --list
 *   npm run restore -- --file backups/kampala-20261001T081500Z.db
 *   npm run restore -- --latest
 *   npm run restore -- --latest --yes     skip the confirmation
 *
 * Every operator session is invalidated by a restore, and the audit log is rolled
 * back with everything else. Say so before it happens, not after.
 */

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { listBackups, verifyBackup, restoreBackup } from '../src/db/backup.js'
import { createReader } from '../src/core/prompt.js'

function parseArgs(argv) {
  const args = { file: null, latest: false, list: false, yes: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--file') {
      args.file = value
      index += 1
    } else if (flag === '--latest') {
      args.latest = true
    } else if (flag === '--list') {
      args.list = true
    } else if (flag === '--yes' || flag === '-y') {
      args.yes = true
    } else if (flag === '--help' || flag === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }
  return args
}

const HELP = `Usage: npm run restore -- [--file <path> | --latest] [--yes]

  --list    Show the backups available
  --file    The backup to restore
  --latest  The newest backup in the directory
  --yes     Do not ask for confirmation

The current database is moved aside rather than deleted, and its path is printed.
Every operator session is invalidated: the session secret is removed so nobody stays
signed in against a database whose state they never saw.`

/**
 * Finds the backup file the operator named.
 *
 * A bare filename is looked for in the backup directory before the working
 * directory, because that is where every backup is and it is where `--list`
 * printed it from. Someone reading the list has `kampala-20261001T081500Z.db` in
 * front of them, and having to reconstruct the path back to the data directory
 * makes the command look broken when it is only being literal.
 *
 * An explicit relative path that exists is honoured as given, so `--dir` and a
 * hand-written path still work the way a shell would.
 */
function resolveBackupPath(named, directory) {
  if (path.isAbsolute(named)) return named

  const inWorkingDirectory = path.resolve(named)
  if (fs.existsSync(inWorkingDirectory)) return inWorkingDirectory

  const inBackupDirectory = path.join(directory, path.basename(named))
  if (fs.existsSync(inBackupDirectory)) return inBackupDirectory

  // Nothing found: report where it looked, because "no backup at <cwd>/<name>"
  // when the operator was looking at the backup directory is the most confusing
  // possible answer.
  return inBackupDirectory
}

/**
 * Confirms before doing anything irreversible.
 *
 * Absent a TTY it refuses rather than proceeding. A restore piped from a script
 * that did not pass `--yes` is a script that wanted the question asked and did not
 * know there was nobody to ask it, and answering it on its behalf is how a
 * database gets replaced by a cron entry nobody wrote deliberately.
 */
async function confirm(question) {
  if (process.stdin.isTTY) {
    const reader = createReader()
    try {
      const answer = await reader.ask(`${question} [y/N] `)
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      reader.close()
    }
  }
  if (process.env.KIP_CONFIRM_RESTORE) {
    return /^(y|es|1)$/i.test(process.env.KIP_CONFIRM_RESTORE.trim())
  }
  throw new Error(
    'Not a terminal, so the confirmation cannot be asked. Re-run with --yes if this is ' +
      'deliberate.',
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  const config = loadConfig()
  const directory = path.join(config.dataDir, 'backups')

  if (args.list || (!args.file && !args.latest)) {
    const files = listBackups(directory)
    if (files.length === 0) {
      process.stdout.write(`No backups in ${directory}.\n`)
      return
    }
    process.stdout.write(`Backups in ${directory}:\n`)
    for (const file of files) {
      const verified = verifyBackup(file)
      const created = verified.manifest?.createdAt
        ? new Date(verified.manifest.createdAt).toISOString()
        : 'unknown date'
      const businesses = verified.manifest?.counts?.business
      process.stdout.write(
        `  ${path.basename(file)}  ${created}  ${businesses ?? '?'} business(es)\n`,
      )
    }
    if (!args.file && !args.latest) {
      process.stdout.write('\nPass --latest, or --file <name>, to restore one of these.\n')
      return
    }
  }

  const file = args.file ? resolveBackupPath(args.file, directory) : listBackups(directory)[0]

  if (!file) {
    throw new Error('There is no backup to restore.')
  }

  const verified = verifyBackup(file)
  if (!verified.exists) throw new Error(`There is no backup at ${file}.`)

  process.stdout.write(`About to restore ${path.basename(file)}\n`)
  process.stdout.write(`  taken at   ${verified.manifest?.createdAt ?? 'unknown'}\n`)
  process.stdout.write(`  over       ${config.database.file}\n`)
  process.stdout.write('  Every operator session will be invalidated, and the audit log\n')
  process.stdout.write('  will be rolled back along with everything else.\n')

  if (!args.yes) {
    const ok = await confirm('  Restore it?')
    if (!ok) {
      process.stdout.write('Left alone.\n')
      return
    }
  }

  const result = restoreBackup(file, {
    dataDir: config.dataDir,
    databaseFile: config.database.file,
  })

  process.stdout.write(`\nRestored from ${result.restoredFrom}\n`)
  if (result.displaced) {
    process.stdout.write(
      `The previous database is at ${result.displaced}. Delete it once you are satisfied.\n`,
    )
  }
  if (result.removedSessionSecret) {
    process.stdout.write(
      'The session secret was removed, so every operator has to sign in again.\n',
    )
  }
  const businesses = result.verified.manifest?.counts?.business
  if (typeof businesses === 'number') {
    process.stdout.write(`  ${businesses} business record(s) in the restored database.\n`)
  }
  process.stdout.write('\nStart the server to migrate the restored database to the current schema.\n')
}

main().catch((error) => {
  process.stderr.write(`Restore failed: ${error.message}\n`)
  process.exitCode = 1
})