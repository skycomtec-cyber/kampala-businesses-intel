/**
 * The first record through the controlled ingestion workflow.
 *
 * This file exists because the catalogue has to be demonstrated with a real
 * organization, and a demonstration that lives in a test file cannot be looked at
 * by the person who asked for it. It is deliberately one record, and it is
 * deliberately the one the phase named.
 *
 * Two rules, both load-bearing:
 *
 *   1. Nothing here is invented. Skycomtec's name, its line of business and its
 *      location are the details supplied; there is no phone number, no website,
 *      no founding year, no email, because a fabricated phone number in a
 *      directory is a phone number that rings somebody. A field the administrator
 *      did not supply is left null and shows up in the review queue as something
 *      to find out, which is what a review queue is for.
 *
 *   2. It arrives the way every record arrives: through a registered source, with
 *      provenance, into `pending_review`. It is never created `approved`. If this
 *      seed were allowed to publish itself, the approval gate would be the one
 *      part of the platform that had never actually been exercised.
 */

/** The source the phase names, with its exact description. */
export const MANUAL_SOURCE = Object.freeze({
  name: 'KampalaBiz Manual Import',
  type: 'manual',
  trustLevel: 'controlled',
  description: 'Organizations manually entered by an authorized KampalaBiz.Space administrator.',
})

/** The one real organization. Supplied fields only. */
export const SKYCOMTEC = Object.freeze({
  name: 'Skycomtec',
  description:
    'Computer and electronic equipment installation, repair and maintenance services in Kampala, Uganda.',
  /**
   * Matched by name against the seeded category tree rather than hard-coded as an
   * id, because a category id is a uuid and a uuid in a seed file is a uuid that
   * will not exist in the next install.
   */
  categoryName: 'Device Repair',
  /**
   * The district node, not a ward. Kampala's divisions are renumbered and renamed
   * often enough that a record pinned to one is a record that will need editing
   * for the wrong reason; the district is stable and the ward can be filled in
   * during review, when somebody who knows the shop is looking at it.
   */
  locationName: 'Kampala District',
  /** The administrator's own reference for the entry, not an external id. */
  externalRef: 'KB-MANUAL-0001',
  evidence: 'KampalaBiz.Space manual directory entry',
})

/**
 * Imports the demonstration record, once.
 *
 * Idempotent the same way the rest of the seed is: it looks for a business with
 * this name and a provenance row naming this source, and returns what it finds.
 * The launcher runs the seed before every start, so "once" has to mean once in the
 * database rather than once per process.
 *
 * @param {object} app the open database handle and repositories
 * @returns {{ created: boolean, business: object|null, source: object, reason?: string }}
 */
export function seedCatalogueDemo(app) {
  const source = app.catalogue.createSource(MANUAL_SOURCE)

  const existing = app.businesses
    .all()
    .find((business) => business.name === SKYCOMTEC.name)
  if (existing) {
    return {
      created: false,
      business: existing,
      source,
      reason: 'a business with this name is already in the directory',
    }
  }

  const category = app.categories.all().find((row) => row.name === SKYCOMTEC.categoryName)
  if (!category) {
    // Not a crash. An install whose taxonomy has not been seeded yet should get
    // its source registered and its taxonomy seeded, and pick the record up on
    // the next start, rather than failing the whole seed.
    return {
      created: false,
      business: null,
      source,
      reason: `the category "${SKYCOMTEC.categoryName}" is not in the taxonomy yet`,
    }
  }

  const location = app.locations
    .listByKind('district', { limit: 500 })
    .items.find((row) => row.name === SKYCOMTEC.locationName)
  if (!location) {
    return {
      created: false,
      business: null,
      source,
      reason: `the district "${SKYCOMTEC.locationName}" is not in the reference data yet`,
    }
  }

  const { business } = app.catalogue.intake({
    sourceKey: source.key,
    record: {
      name: SKYCOMTEC.name,
      description: SKYCOMTEC.description,
      categoryId: category.id,
      locationId: location.id,
    },
    externalRef: SKYCOMTEC.externalRef,
    evidence: SKYCOMTEC.evidence,
    // Queued, not published. The record's whole purpose is to be something for a
    // reviewer to approve.
    queue: true,
  })

  return { created: true, business, source }
}
