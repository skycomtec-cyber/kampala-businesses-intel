import { config as defaultConfig } from '../config.js'
import { openDatabase, closeDatabase, DEFAULT_MIGRATIONS_DIR } from './driver.js'
import { migrate, migrationStatus, readMigrations, appliedMigrations } from './migrator.js'
import { createRepositories } from './repositories/index.js'

/**
 * The data layer entry point.
 *
 * `openApp` is the only thing the rest of the platform calls to reach the
 * database. It gives back a handle, the resolved config and the repository set,
 * and it can bring the schema up to date on the way, which is what lets the
 * Pinokio launcher run `install` and then `start` without a separate migration
 * step that the user can forget.
 */

export { openDatabase, closeDatabase, DEFAULT_MIGRATIONS_DIR }
export { migrate, migrationStatus, readMigrations, appliedMigrations }
export { createRepositories }

export function openApp(options = {}) {
  const config = options.config ?? defaultConfig
  const db = openDatabase(config, { readonly: options.readonly })

  if (options.migrate !== false) {
    migrate(db, {
      dir: options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
      onProgress: options.onMigration,
    })
  }

  const repositories = createRepositories(db, config)

  return {
    config,
    db,
    ...repositories,
    close() {
      closeDatabase(db)
    },
  }
}
