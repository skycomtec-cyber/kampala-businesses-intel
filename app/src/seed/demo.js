import zlib from 'node:zlib'
import { newId } from '../core/identifiers.js'
import { buildPhotoUpload } from '../core/photos.js'
import { SKILLS } from './reference-data.js'
import { DEMO_BUSINESSES, DEMO_DEMAND, DEMO_PHOTOS, DEMO_REVIEWS } from './demo-data.js'

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
 * The demonstration's photographs, generated rather than shipped.
 *
 * There is no honest way to include a picture of a business that does not exist,
 * so the demonstration makes its own: a vertical shade, one hue per business,
 * written by hand as a PNG. Doing it here rather than with an image library keeps
 * a dependency out of the project for something used exactly once, and writing it
 * from a name rather than `Math.random` keeps the picture the same on every build,
 * so a screenshot taken today still matches one taken next month.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One PNG chunk: a length, the type, the data, and a checksum over the last two. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, checksum])
}

/** A hue in the 0-359 range from a name. A plain string hash, not a digest. */
function hueFor(text) {
  let hue = 0
  for (const character of text) hue = (hue * 31 + character.codePointAt(0)) % 360
  return hue
}

/** HSL to 8-bit RGB, with the hue given in turns (0-1) rather than degrees. */
function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue * 6) % 2) - 1))
  const match = lightness - chroma / 2
  let red
  let green
  let blue
  if (hue < 1 / 6) [red, green, blue] = [chroma, second, 0]
  else if (hue < 2 / 6) [red, green, blue] = [second, chroma, 0]
  else if (hue < 3 / 6) [red, green, blue] = [0, chroma, second]
  else if (hue < 4 / 6) [red, green, blue] = [0, second, chroma]
  else if (hue < 5 / 6) [red, green, blue] = [second, 0, chroma]
  else [red, green, blue] = [chroma, 0, second]
  return [
    Math.round((red + match) * 255),
    Math.round((green + match) * 255),
    Math.round((blue + match) * 255),
  ]
}

/** A small truecolour PNG for a text, deterministic for that text. */
function placeholderPhoto(text, { width = 640, height = 400 } = {}) {
  const hue = hueFor(text) / 360
  const rows = Buffer.alloc(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    rows[offset] = 0 // filter type: none, the only one this writes
    offset += 1
    // Darker toward the bottom, so the result is visibly an image rather than a
    // flat block of colour, which matters when the point is a gallery.
    const lightness = 0.74 - (0.36 * y) / (height - 1)
    const [red, green, blue] = hslToRgb(hue, 0.42, lightness)
    for (let x = 0; x < width; x += 1) {
      rows[offset] = red
      rows[offset + 1] = green
      rows[offset + 2] = blue
      offset += 3
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per channel
  header[9] = 2 // colour type: truecolour
  header[10] = 0 // compression method: deflate
  header[11] = 0 // filter method
  header[12] = 0 // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Writes the demonstration reviews, through the same two calls the api makes.
 *
 * `create` always lands a review pending and `moderate` is the only method that
 * changes that, so a published review in the demonstration went through exactly the
 * path a submitted one does. An entry with no `decision` is left waiting on
 * purpose, because the queue is the feature and it should open with work in it.
 */
function seedReviews(app, businesses) {
  const byName = new Map(businesses.map((business) => [business.name, business]))
  return DEMO_REVIEWS.map((row) => {
    const business = byName.get(row.business)
    if (!business) {
      throw new Error(
        `The demonstration reviews refer to business "${row.business}", which is not in ` +
          'DEMO_BUSINESSES. This is a bug in demo-data.js.',
      )
    }
    const review = app.reviews.create({
      businessId: business.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      authorName: row.authorName,
      authorEmail: row.authorEmail,
    })
    if (!row.decision) return review
    return app.reviews.moderate(review.id, {
      decision: row.decision,
      reason: row.reason ?? 'Demonstration seed.',
    })
  })
}

/**
 * Writes the demonstration photographs.
 *
 * The generated bytes are handed back through `buildPhotoUpload`, the same entry
 * point an upload uses, so an image the platform would refuse cannot be seeded by
 * construction. The file is written before the row, as in the api, and the media
 * store owns the key.
 */
function seedPhotos(app, media, businesses) {
  const byName = new Map(businesses.map((business) => [business.name, business]))
  return DEMO_PHOTOS.map((row) => {
    const business = byName.get(row.business)
    if (!business) {
      throw new Error(
        `The demonstration photos refer to business "${row.business}", which is not in ` +
          'DEMO_BUSINESSES. This is a bug in demo-data.js.',
      )
    }
    const bytes = placeholderPhoto(`${row.business}:${row.position ?? 0}`)
    const upload = buildPhotoUpload({
      data: `data:image/png;base64,${bytes.toString('base64')}`,
      caption: row.caption,
      altText: row.altText,
    })
    const storageKey = `${newId()}.${upload.extension}`
    media.write(storageKey, upload.bytes)
    const photo = app.photos.create({
      businessId: business.id,
      storageKey,
      mimeType: upload.mimeType,
      byteSize: upload.bytes.length,
      caption: upload.caption,
      altText: upload.altText,
      position: row.position ?? 0,
      source: 'admin',
    })
    if (!row.decision) return photo
    return app.photos.moderate(photo.id, {
      decision: row.decision,
      reason: row.reason ?? 'Demonstration seed.',
    })
  })
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
 * @param {{ now?: Date, media?: object }} [options] the instant "today" is measured
 *   from, and the media store the photographs are written to. Without a media store
 *   the reviews are still written and no photograph is, which is what lets a test
 *   that only cares about the market model skip the files.
 * @returns {{ businesses: object[], phrases: object[], reviews: object[], photos: object[] }}
 */
export function seedDemo(app, { now = new Date(), media = null } = {}) {
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
  // Reviews and photos hang off a business, so they come after the supply exists.
  const reviews = seedReviews(app, businesses)
  const photos = media ? seedPhotos(app, media, businesses) : []
  return { businesses, phrases, reviews, photos }
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
