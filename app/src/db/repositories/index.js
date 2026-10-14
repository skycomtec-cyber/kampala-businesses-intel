import { createUsersRepository, createSessionsRepository, createPasswordResetRepository, createAuditRepository } from './users.js'
import { createLocationsRepository } from './locations.js'
import { createCategoriesRepository, createSkillsRepository } from './taxonomy.js'
import { createSearchIndexRepository } from './searchIndex.js'
import { createBusinessesRepository } from './businesses.js'
import { createCatalogueRepository } from './catalogue.js'
import { createDemandRepository } from './demand.js'
import { createMarketplaceRepository } from './marketplace.js'
import { createIntelligenceRepository } from './intelligence.js'
import { createSecondLifeRepository } from './secondLife.js'
import { createClaimsRepository } from './claims.js'
import { createReviewsRepository } from './reviews.js'
import { createPhotosRepository } from './photos.js'

/**
 * Repository wiring.
 *
 * The order below is the dependency order and it matters: the search index needs
 * the database, businesses need the index (so a write reindexes in the same
 * transaction), the catalogue needs businesses (so an intake can write the record
 * and its provenance together), and skills need nothing. Every repository is a
 * plain object over the same better-sqlite3 handle, which is why
 * `createBusinessesRepository` can call `skills.findOrCreate` without a module
 * import cycle.
 *
 * Nothing above this line imports better-sqlite3, so swapping the engine means
 * replacing `db/driver.js` and reimplementing this folder's signatures.
 */
export function createRepositories(db, config) {
  const users = createUsersRepository(db, config)
  const sessions = createSessionsRepository(db, config)
  const passwordResets = createPasswordResetRepository(db, config)
  const audit = createAuditRepository(db)
  const locations = createLocationsRepository(db)
  const categories = createCategoriesRepository(db)
  const skills = createSkillsRepository(db)
  const searchIndex = createSearchIndexRepository(db)
  const businesses = createBusinessesRepository(db, { searchIndex, skills, locations })
  const catalogue = createCatalogueRepository(db, { businesses, audit })
  const demand = createDemandRepository(db, config)
  const marketplace = createMarketplaceRepository(db, config)
  const intelligence = createIntelligenceRepository(db, config)
  const secondLife = createSecondLifeRepository(db, config)
  // Claims depend on the three things a grant touches: the listing being claimed,
  // the account it creates and the reset token that delivers it. It is wired last
  // so all three already exist.
  const claims = createClaimsRepository(db, config, { businesses, users, passwordResets })
  // Reviews are independent of the other repositories: a review references a
  // business by foreign key, and the rating a profile shows is composed by the
  // route rather than baked into the business repository. That keeps the two
  // from depending on each other in a cycle.
  const reviews = createReviewsRepository(db)
  // Photos are the same shape as reviews: a submission held pending whose only
  // transition is a recorded decision. The bytes live outside the database, so
  // this repository holds metadata alone and the media store is wired by the api
  // layer rather than here.
  const photos = createPhotosRepository(db)

  return {
    db,
    users,
    sessions,
    passwordResets,
    audit,
    locations,
    categories,
    skills,
    searchIndex,
    businesses,
    catalogue,
    demand,
    marketplace,
    intelligence,
    secondLife,
    claims,
    reviews,
    photos,

    /**
     * Runs a unit of work atomically.
     *
     * better-sqlite3 is synchronous, so this is the whole concurrency story: a
     * transaction cannot be interleaved because there is no await inside it. The
     * one rule that follows from that is that no callback passed here may perform
     * I/O, or the whole database blocks until it finishes.
     */
    transaction(fn) {
      return db.transaction(fn)
    },

    /** Cheap liveness check for the health endpoint. */
    health() {
      const row = db.prepare('SELECT COUNT(*) AS total FROM schema_migration').get()
      return {
        ok: true,
        migrations: row.total,
        database: config.database.file,
        fts: true,
      }
    },
  }
}
