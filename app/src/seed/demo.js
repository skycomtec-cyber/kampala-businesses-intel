import { SKILLS } from './reference-data.js'
import { DEMO_BUSINESSES, DEMO_DEMAND } from './demo-data.js'

/**
 * Applying the demonstration dataset.
 *
 * See `demo-data.js` for why this exists and why it is kept out of the ordinary
 * seed. This file is the part that writes it, and it is written to be boring: every
 * row goes through the same repositories and the same review path a real listing
 * goes through, so a demonstration cannot drift into a shape the platform would
 * never actually produce.
 *
 * That is the whole design rule here. A demo that inserts rows directly into the
 * tables would be easier to write and would be worth nothing, because the fields it
 * skipped would be exactly the fields the product is judged on. So a demonstration
 * business is created unpublished, sent through `review`, and only then counted as
 * supply - and a demonstration search is recorded as an event, rolled up by the same
 * daily rollup the scheduled job uses, and never written straight into a signal
 * table.
 *
 * Determinism is the other rule. The same seed produces the same database every
 * time, so two runs can be compared and a screenshot stays true. There is no
 * `Math.random` anywhere in this file or the data it reads.
 */

/** The `source_id` every demonstration record carries, and the one place it is named. */
export const DEMO_SOURCE_ID = 'seed:demo'

/**
 * The skill vocabulary, by name.
 *
 * Read from the platform's own `SKILLS` rather than restated, so the demonstration
 * is categorised by the same vocabulary an operator would use. A skill the platform
 * does not know is a bug in this file, not a new skill.
 */
const skillsByName = new Map(SKILLS.map((skill) => [skill.name, skill]))

/**
 * Resolves a category path such as `services/trades-and-construction/plumbing` to
 * a row, one segment at a time.
 *
 * Walked rather than looked up by a joined path string, because paths are the
 * reference data's own representation and the database stores parent ids. A path
 * that does not resolve is a reference-data problem and is reported as one, rather
 * than silently falling back to a root and putting a plumber in Second Life
 * Electronics.
 */
function resolveCategoryId(app, path) {
  let parentId = null
  let row = null
  for (const segment of path.split('/')) {
    row = app.categories.findBySlug(segment, parentId)
    if (!row) {
      throw new Error(
        `The demonstration dataset refers to category "${path}", which the reference ` +
          `data does not contain (missing "${segment}"). This is a bug in demo-data.js, ` +
          `not a request to create a category.`,
      )
    }
    parentId = row.id
  }
  return row.id
}

/** Every location in the tree, indexed by name. Names in the reference data are unique. */
function indexLocations(app) {
  const byName = new Map()
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      byName.set(node.name, node)
      walk(app.locations.children(node.id))
    }
  }
  walk(app.locations.children(null))
  return byName
}

function requireLocation(byName, name) {
  const row = byName.get(name)
  if (!row) {
    throw new Error(
      `The demonstration dataset refers to location "${name}", which the reference data ` +
        `does not contain. This is a bug in demo-data.js.`,
    )
  }
  return row
}

/**
 * Creates one demonstration business and publishes it through the review path.
 *
 * Unpublished, then `verify`, then `approve`, in that order, because the review
 * state machine has no path to `approved` that skips `verified` - "somebody checked
 * this" and "we will publish this" are separate claims, and a seed that published in
 * one step would be asserting the second without ever making the first.
 */
function publishBusiness(app, { skillName, placeName, name, description }, locations) {
  const skill = skillsByName.get(skillName)
  if (!skill) {
    throw new Error(
      `The demonstration dataset refers to skill "${skillName}", which is not in the ` +
        `platform's skill vocabulary. This is a bug in demo-data.js.`,
    )
  }

  const location = requireLocation(locations, placeName)
  const categoryId = resolveCategoryId(app, skill.category)

  const business = app.businesses.create({
    categoryId,
    locationId: location.id,
    status: 'active',
    name,
    // Self-describing on its own terms, so a single record copied out of the
    // database is still honest about being a demonstration record.
    description: `${description} (demonstration listing, not a real business.)`,
    sourceId: DEMO_SOURCE_ID,
  })

  app.businesses.addSkill(business.id, skillName, { proficiency: 0.7, isPrimary: true })
  app.businesses.review(business.id, { action: 'verify', reason: 'Demonstration seed.' })
  app.businesses.review(business.id, { action: 'approve', reason: 'Demonstration seed.' })

  return { id: business.id, name, skill: skillName, place: placeName }
}

/**
 * Which day each search of one phrase lands on, as an offset back from today.
 *
 * The first search of every phrase is placed today, without exception. The engine's
 * window ends today, and a dataset that never searched today would be
 * indistinguishable from the broken window that could not see today - which is the
 * exact confusion this dataset is meant to rule out when someone runs the engine
 * against it.
 *
 * `rising` moves three quarters of the demand into the last three days so the trend
 * comparison has a baseline to disagree with. Without a baseline a phrase is
 * annotated as new rather than rising, and the trend annotation would never be
 * demonstrated at all.
 */
function planDayOffsets({ searches, days, rising }) {
  const span = Math.max(1, days)
  const offsets = [0]
  for (let index = 1; index < searches; index += 1) {
    if (rising && index % 4 !== 0) {
      offsets.push(index % 3)
    } else {
      offsets.push((index * 5) % span)
    }
  }
  return offsets
}

/**
 * The instant a search is recorded at, for one day offset.
 *
 * Today's searches are stamped `now` rather than a fixed hour, because a fixed hour
 * is in the future for the first few minutes of every UTC day and a search dated in
 * the future is a thing the rollup should not have to think about. Any hour is fine
 * on a past day.
 */
function instantFor(offset, now) {
  if (offset === 0) return new Date(now)
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - offset)
  date.setUTCHours(9, 0, 0, 0)
  return date
}

/**
 * Records the searches for one phrase.
 *
 * `actors` distinct people, cycled across `searches` events, so the number of
 * distinct actors in the rollup is exactly `min(actors, searches)`. The k-anonymity
 * floor counts distinct people rather than events, which is the whole point of the
 * floor and the reason this is expressed as two numbers instead of one.
 */
function recordPhrase(app, row, location, now) {
  const offsets = planDayOffsets(row)
  const distinctActors = Math.min(row.actors, row.searches)

  for (let index = 0; index < row.searches; index += 1) {
    const at = instantFor(offsets[index], now)
    app.demand.recordSearch({
      query: row.query,
      locationId: location.id,
      coverageLevel: row.coverageLevel,
      totalResults: row.results,
      inAreaResults: row.results,
      // Distinct per phrase, so two phrases do not accidentally share an actor pool
      // and a phrase's own floor is decided by its own searches.
      actorSeed: `demo:${row.place}:${row.query}:${index % distinctActors}`,
      at,
    })
  }

  return { phrase: row.query, place: row.place, events: row.searches, actors: distinctActors }
}

/**
 * Writes the demonstration dataset.
 *
 * Reference data first: every category, skill and location this dataset refers to
 * has to exist before a business can be placed in it, and a demonstration that
 * depended on the operator having seeded already would be one more thing to forget.
 *
 * Does not roll up or measure. That is left to the caller, deliberately, so the
 * demonstration is produced by the same `rollupDay` and the same `runGapEngine` the
 * scheduled job uses. A demo that wrote `gap_snapshot` rows directly would be
 * demonstrating the fixture rather than the platform.
 *
 * @param {object} app the open database handle and repositories
 * @param {{ now?: Date }} [options] the instant "today" is measured from
 * @returns {{ businesses: object[], phrases: object[] }}
 */
export function seedDemo(app, { now = new Date() } = {}) {
  const locations = indexLocations(app)

  // The dataset stores each business as a positional row, which keeps twenty-odd
  // entries readable as a table. It is turned into a named object here, once, at the
  // boundary - passing the row straight through to a function that destructures
  // named fields yields four `undefined`s and an error about a skill called
  // "undefined", which is a long way from the mistake.
  const businesses = DEMO_BUSINESSES.map(([skillName, placeName, name, description]) =>
    publishBusiness(app, { skillName, placeName, name, description }, locations),
  )
  const phrases = DEMO_DEMAND.map((row) =>
    recordPhrase(app, row, requireLocation(locations, row.place), now),
  )
  return { businesses, phrases }
}

/**
 * How many published businesses sit at or below a location, and its descendants.
 *
 * The coverage question the product has to answer, counted the way the data is
 * stored. A demonstration is only useful if the coverage it shows is uneven, because
 * a single number cannot describe both "fourteen businesses serve this" and
 * "nothing is known here", and a dataset that is uniform proves nothing about
 * either.
 */
export function demoCoverage(app) {
  const locations = indexLocations(app)
  const published = app.businesses.publiclyVisible()

  const countAt = (name) => {
    const root = locations.get(name)
    if (!root) return 0
    const ids = new Set([root.id, ...app.locations.descendants(root.id).map((row) => row.id)])
    return published.filter((business) => ids.has(business.primaryLocationId)).length
  }

  return { entebbe: countAt('Entebbe'), kampala: countAt('Kampala'), mukono: countAt('Mukono') }
}
