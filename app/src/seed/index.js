import { slugify } from '../core/identifiers.js'
import { seedCatalogueDemo } from './catalogue-demo.js'
import {
  CATEGORIES,
  CATEGORIES_VERSION,
  LOCATIONS,
  LOCATIONS_VERSION,
  SKILLS,
  SKILLS_VERSION,
  verticalForCategoryPath,
} from './reference-data.js'

/**
 * Applying the reference dataset.
 *
 * Idempotent by construction, so this can run before every start without the
 * caller having to know whether it has already run. Every row is matched on its
 * natural key, never on its id, which is what lets a later revision of the dataset
 * be applied over an existing database without orphaning the businesses that
 * already point at a location.
 */

/**
 * Walks the location tree, creating each node under its parent.
 *
 * Matched on (parent, slug) rather than on name, so a re-run writes nothing, and a
 * node renamed in a future revision arrives as a new node instead of silently
 * merging into an old one that other rows already point at.
 */
function seedLocations(app, counters) {
  const walk = (nodes, parentId) => {
    for (const node of nodes) {
      const slug = slugify(node.name)
      const existing = app.locations.findBySlug(slug, parentId)
      const row =
        existing ??
        app.locations.create({
          kind: node.kind,
          name: node.name,
          slug,
          parentId,
          latitude: node.latitude ?? null,
          longitude: node.longitude ?? null,
          externalCode: node.externalCode ?? null,
          sourceId: 'seed:reference-data',
        })
      if (!existing) counters.locations += 1
      walk(node.children ?? [], row.id)
    }
  }
  walk(LOCATIONS, null)
  // Cheap, and the repair hatch for a tree that was imported by an older revision
  // of this file.
  app.locations.rebuildPaths()
}

/**
 * Every category path, depth first, resolving each parent by its path.
 *
 * The five roots come from `core/taxonomy.js` rather than from the paths below,
 * because the root carries a display name and a description ("Second Life
 * Electronics", with a sentence explaining what the vertical is for) that a slug
 * cannot reconstruct.
 */
function seedCategories(app, counters) {
  const byPath = new Map()
  for (const root of app.categories.ensureRoots()) {
    byPath.set(root.slug, root)
  }

  const ensure = (path) => {
    if (byPath.has(path)) return byPath.get(path)

    const segments = path.split('/')
    const slug = segments.pop()
    const parent = segments.length > 0 ? ensure(segments.join('/')) : null
    const existing = app.categories.findBySlug(slug, parent ? parent.id : null)
    const row =
      existing ??
      app.categories.create({
        name: humanise(slug),
        slug,
        parentId: parent ? parent.id : null,
        sortWeight: 1000,
        vertical: verticalForCategoryPath(path),
        sourceId: 'seed:reference-data',
      })
    if (!existing) counters.categories += 1
    byPath.set(path, row)
    return row
  }

  const walk = (node) => {
    ensure(node.path)
    for (const descendant of node.children ?? []) walk(descendant)
  }
  for (const root of CATEGORIES) walk(root)

  return byPath
}

/** A slug becomes the name a person reads: "phone-repair" -> "Phone Repair". */
function humanise(slug) {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Skills, then their links to categories.
 *
 * `findOrCreate` means an operator who already typed a skill into a listing keeps
 * the same skill id, so the link table never grows a second row for a skill that
 * already exists under a different spelling. Synonyms are merged rather than
 * replaced, because they are also collected from listings over time.
 */
function seedSkills(app, categoriesByPath, counters) {
  for (const skill of SKILLS) {
    const row = app.skills.findOrCreate(skill.name, {
      sourceId: 'seed:reference-data',
      vertical: verticalForCategoryPath(skill.category),
    })
    counters.skills += 1

    if (skill.synonyms?.length) {
      const known = new Set(row.synonyms.map((term) => term.toLowerCase()))
      const merged = [
        ...row.synonyms,
        ...skill.synonyms.filter((term) => !known.has(term.toLowerCase())),
      ]
      if (merged.length !== row.synonyms.length) {
        app.skills.update(row.id, { synonyms: merged })
      }
    }

    const category = categoriesByPath.get(skill.category)
    if (category) {
      app.categories.linkSkill(category.id, row.id)
      counters.links += 1
    }
  }
}

/** Records which revision of which dataset this installation is carrying. */
function recordProvenance(app) {
  const locationKinds = ['country', 'region', 'district', 'city', 'town', 'division', 'subcounty', 'ward']

  app.locations.recordReferenceSource({
    id: 'seed:locations',
    name: 'Uganda administrative geography (Kampala metro focus)',
    kind: 'location',
    version: LOCATIONS_VERSION,
    sourceUri: null,
    licence: 'Hand-maintained reference data',
    rowCount: locationKinds.reduce((total, kind) => total + app.locations.byKind(kind).length, 0),
    notes: 'Countries, regions, districts, cities, towns and Kampala divisions.',
  })
  app.locations.recordReferenceSource({
    id: 'seed:categories',
    name: 'Platform taxonomy',
    kind: 'category',
    version: CATEGORIES_VERSION,
    rowCount: app.categories.all().length,
    notes: 'Roots from core/taxonomy.js plus the paths in src/seed/reference-data.js.',
  })
  app.locations.recordReferenceSource({
    id: 'seed:skills',
    name: 'Platform skill vocabulary',
    kind: 'skill',
    version: SKILLS_VERSION,
    rowCount: app.skills.count(),
    notes: 'Open vocabulary: operators may add skills that are not on this list.',
  })
}

/**
 * Applies the reference dataset and reports what changed.
 *
 * @param {object} app the open database handle and repositories
 * @param {{ config?: object }} [options] `config.seed.reference === false` skips the lot
 * @returns {{ locations: number, categories: number, skills: number, links: number, skipped: boolean }}
 */
export function seedReferenceData(app, { config = { seed: { reference: true } } } = {}) {
  if (config.seed.reference === false) {
    return { locations: 0, categories: 0, skills: 0, links: 0, skipped: true }
  }

  const counters = { locations: 0, categories: 0, skills: 0, links: 0, skipped: false }
  seedLocations(app, counters)
  seedSkills(app, seedCategories(app, counters), counters)
  recordProvenance(app)
  return counters
}

/**
 * Registers the manual source and imports the one real demonstration record.
 *
 * Not part of `seedReferenceData`, and the split is the point. `seedReferenceData`
 * is vocabulary: countries, districts, categories, skills, the things every
 * install shares. This is content: one business, arriving through the catalogue
 * like any other, landing in the review queue. Bundling them would mean either
 * every test that counts businesses has to know about the demonstration record,
 * or the switch that turns the demonstration off also turns off the district list.
 *
 * Runs after the reference data, because a record with no category and no district
 * is a queue item nobody can triage.
 *
 * @param {object} app the open database handle and repositories
 * @param {{ config?: object }} [options] `config.seed.catalogueDemo === false` skips it
 * @returns {{ skipped: boolean, created: boolean, state: string|null, reason: string|null }}
 */
export function seedCatalogue(app, { config = { seed: { catalogueDemo: true } } } = {}) {
  if (config.seed.catalogueDemo === false) {
    return { skipped: true, created: false, state: null, reason: null }
  }

  const result = seedCatalogueDemo(app)
  return {
    skipped: false,
    created: result.created,
    state: result.business?.verificationState ?? null,
    reason: result.reason ?? null,
  }
}
