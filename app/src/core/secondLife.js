import { ConflictError, ValidationError } from './errors.js'

/**
 * Second Life Electronics domain rules.
 *
 * This vertical answers one question a directory of businesses cannot: what
 * actually happens to a device after somebody hands it over. The taxonomy says
 * "this business does device repair"; an intake says "this specific phone came in
 * on Tuesday, was diagnosed, had its screen replaced and went back out". The
 * rules below are the vocabulary for that journey and the small number of things
 * that must be true along it.
 *
 * Everything here is a pure function of its inputs, for the reason the whole core
 * layer exists: an intake closed six months ago must be re-explainable without the
 * database, the clock or a running server. There is no import of `db`, `api` or
 * `web` anywhere in this file, and there must never be one.
 */

/** The taxonomy root every second-life subcategory hangs from. */
export const SECOND_LIFE_ROOT_SLUG = 'second-life-electronics'

/**
 * The six activities, in the order the vertical's own documentation lists them.
 *
 * These are the business-facing names. They are mapped to the category slugs that
 * already exist in the reference dataset rather than reusing them directly,
 * because the activity is what an operator records and the category is where the
 * resulting listing is filed, and those two things should be allowed to diverge
 * without one of them silently becoming the other.
 */
export const SECOND_LIFE_ACTIVITIES = Object.freeze([
  'repair',
  'refurbishment',
  'parts_recovery',
  'resale',
  'recycling',
  'data_services',
])

/** Activity -> the subcategory slug it is filed under. */
export const ACTIVITY_CATEGORY_SLUGS = Object.freeze({
  repair: 'device-repair',
  refurbishment: 'device-refurbishment',
  parts_recovery: 'parts-recovery',
  resale: 'resale-and-trading',
  recycling: 'recycling-and-e-waste',
  data_services: 'data-and-storage-services',
})

/** Human wording for each activity, for menus and summaries. */
export const ACTIVITY_LABELS = Object.freeze({
  repair: 'Repair',
  refurbishment: 'Refurbishment',
  parts_recovery: 'Parts recovery',
  resale: 'Resale & trading',
  recycling: 'Recycling & e-waste',
  data_services: 'Data & storage services',
})

/**
 * The intake lifecycle.
 *
 * A strictly ordered list rather than a graph, because the actual world is a
 * line: a device arrives, is looked at, is worked on, is finished, and the record
 * closes. Operators routinely skip a stage — a screen swap needs no separate
 * "diagnosed" moment — so moving forward is allowed to skip, but moving backward
 * is not, because a device cannot un-arrive.
 */
export const INTAKE_STAGES = Object.freeze([
  'received',
  'diagnosed',
  'in_progress',
  'ready',
  'closed',
])

/** The stage an intake is born in. */
export const INTAKE_OPENING_STAGE = 'received'

/** The one terminal stage. */
export const INTAKE_CLOSED_STAGE = 'closed'

const STAGE_RANK = Object.freeze(
  INTAKE_STAGES.reduce((acc, stage, index) => {
    acc[stage] = index
    return acc
  }, {}),
)

export function stageRank(stage) {
  assertStage(stage)
  return STAGE_RANK[stage]
}

export function isClosed(stage) {
  return stage === INTAKE_CLOSED_STAGE
}

/**
 * What a device can be when it arrives.
 *
 * A closed list on purpose. The summary groups by this field, and a free-text
 * column here would produce a summary with "telephone", "phone" and "mobile" as
 * three separate device types that all mean the same thing.
 */
export const DEVICE_TYPES = Object.freeze([
  'smartphone',
  'laptop',
  'desktop',
  'tablet',
  'television',
  'monitor',
  'printer',
  'appliance',
  'battery',
  'component',
  'other',
])

/**
 * The condition as received.
 *
 * Not the `product.condition` list. That list describes a thing offered for sale
 * ("refurbished", "used_good"); this one describes a thing brought in for work
 * ("faulty", "water_damaged"). Reusing one list for both would force an operator
 * to call a dead phone "used_fair", which is a lie in the direction that matters.
 */
export const RECEIVED_CONDITIONS = Object.freeze([
  'working',
  'faulty',
  'for_parts',
  'water_damaged',
  'physical_damage',
  'unknown',
])

/**
 * What happened to the device.
 *
 * These are the only honest endings. `returned` is here and is not a failure: a
 * device the owner decided not to have repaired is a real, recorded outcome, and
 * without it operators record it as "scrapped" and the numbers lie.
 */
export const INTAKE_OUTCOMES = Object.freeze([
  'repaired',
  'refurbished',
  'parts_recovered',
  'resold',
  'recycled',
  'returned',
  'scrapped',
])

/**
 * Which activity an outcome belongs to, when the platform attributes recovered
 * value back to the vertical. The intake's own `activity` is what the operator
 * chose; this is what the outcome actually turned out to be, and the summary
 * reports both so a shop that takes everything in "for repair" and ends up
 * scrapping half of it is visible.
 */
export const OUTCOME_ACTIVITY = Object.freeze({
  repaired: 'repair',
  refurbished: 'refurbishment',
  parts_recovered: 'parts_recovery',
  resold: 'resale',
  recycled: 'recycling',
  returned: null,
  scrapped: null,
})

/**
 * Outcomes that mean the device leaves the business's custody.
 *
 * This is the list the data-wipe rule is built on. A wipe that is still
 * outstanding is only a risk if the device goes somewhere it can be read, and
 * these are the outcomes where it does.
 */
export const OUTCOMES_LEAVING_CUSTODY = Object.freeze([
  'resold',
  'parts_recovered',
  'recycled',
  'returned',
])

/** Human wording, same reasoning as labelFor in core/catalogue.js. */
const STAGE_LABELS = Object.freeze({
  received: 'received',
  diagnosed: 'diagnosed',
  in_progress: 'being worked on',
  ready: 'ready',
  closed: 'closed',
})

const OUTCOME_LABELS = Object.freeze({
  repaired: 'repaired',
  refurbished: 'refurbished',
  parts_recovered: 'parts recovered',
  resold: 'resold',
  recycled: 'recycled',
  returned: 'returned to owner',
  scrapped: 'scrapped',
})

export function assertActivity(activity) {
  if (!SECOND_LIFE_ACTIVITIES.includes(activity)) {
    throw new ValidationError(`Unknown second-life activity "${activity}".`, {
      allowed: SECOND_LIFE_ACTIVITIES,
    })
  }
  return activity
}

export function assertDeviceType(deviceType) {
  if (!DEVICE_TYPES.includes(deviceType)) {
    throw new ValidationError(`Unknown device type "${deviceType}".`, {
      allowed: DEVICE_TYPES,
    })
  }
  return deviceType
}

export function assertReceivedCondition(condition) {
  if (!RECEIVED_CONDITIONS.includes(condition)) {
    throw new ValidationError(`Unknown received condition "${condition}".`, {
      allowed: RECEIVED_CONDITIONS,
    })
  }
  return condition
}

export function assertStage(stage) {
  if (!INTAKE_STAGES.includes(stage)) {
    throw new ValidationError(`Unknown intake stage "${stage}".`, {
      allowed: INTAKE_STAGES,
    })
  }
  return stage
}

export function assertOutcome(outcome) {
  if (!INTAKE_OUTCOMES.includes(outcome)) {
    throw new ValidationError(`Unknown intake outcome "${outcome}".`, {
      allowed: INTAKE_OUTCOMES,
    })
  }
  return outcome
}

/** The subcategory slug an activity is filed under. */
export function categorySlugForActivity(activity) {
  return ACTIVITY_CATEGORY_SLUGS[assertActivity(activity)]
}

/** The activity a subcategory slug belongs to, or null if it is not one of ours. */
export function activityForCategorySlug(slug) {
  const entry = Object.entries(ACTIVITY_CATEGORY_SLUGS).find(([, value]) => value === slug)
  return entry ? entry[0] : null
}

export function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] ?? activity
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage
}

export function outcomeLabel(outcome) {
  return OUTCOME_LABELS[outcome] ?? outcome
}

/** The activity an outcome counts towards, or null for an outcome with no activity. */
export function activityForOutcome(outcome) {
  return OUTCOME_ACTIVITY[assertOutcome(outcome)] ?? null
}

/**
 * Whether a stage may move directly to another stage.
 *
 * Forward only, and never into `closed` — closing is a separate action that must
 * name an outcome, so allowing it through a plain stage move would let a device
 * be closed with nothing recorded about where it went.
 */
export function canAdvance(from, to) {
  assertStage(from)
  assertStage(to)
  if (isClosed(from)) return false
  if (isClosed(to)) return false
  return STAGE_RANK[to] > STAGE_RANK[from]
}

/** The stages an intake in `from` may move to, for a UI that only offers legal moves. */
export function nextStages(from) {
  assertStage(from)
  if (isClosed(from)) return []
  const forward = INTAKE_STAGES.filter(
    (stage) => stage !== INTAKE_CLOSED_STAGE && STAGE_RANK[stage] > STAGE_RANK[from],
  )
  // `closed` is a legal destination from any open stage, but it is reached through
  // the close action and not a stage move, so it is advertised here (a ui needs to
  // know it can finish a job) while `canAdvance` still refuses it.
  return [...forward, INTAKE_CLOSED_STAGE]
}

/**
 * Refuses an impossible stage move, and names the legal ones.
 *
 * A 409 rather than a 400: the request is well formed, the intake simply is not in
 * a state that allows it. Same reasoning as assertTransition in core/catalogue.js.
 */
export function assertAdvance(from, to) {
  assertStage(from)
  assertStage(to)
  if (from === to) {
    throw new ConflictError(`This intake is already ${stageLabel(to)}.`, { from, to })
  }
  if (isClosed(from)) {
    throw new ConflictError('This intake is closed and its stage cannot change.', {
      from,
      to,
    })
  }
  if (isClosed(to)) {
    throw new ValidationError('Close an intake with an outcome rather than a stage move.', {
      field: 'stage',
    })
  }
  if (!canAdvance(from, to)) {
    throw new ConflictError(
      `An intake cannot go from ${stageLabel(from)} back to ${stageLabel(to)}.`,
      { from, to, allowed: nextStages(from) },
    )
  }
  return to
}

/**
 * The data-wipe rule, stated once.
 *
 * A device whose storage has not been wiped may not leave the business's custody.
 * The rule fires only when a wipe was actually requested, because most walk-in
 * devices are handed back to the same person who brought them in and wiping them
 * would be destroying the customer's own data. Where it does fire, it is a refusal
 * and not a warning: the whole point of the vertical's data-and-storage-services
 * category is that this is a promise rather than an aspiration.
 */
export function assertDataWipeSatisfied({ outcome, dataWipeRequested, dataWipeCompleted }) {
  if (!dataWipeRequested || dataWipeCompleted) return true
  if (!OUTCOMES_LEAVING_CUSTODY.includes(outcome)) return true
  throw new ConflictError(
    `A device cannot be ${outcomeLabel(outcome)} while the requested data wipe is outstanding. ` +
      'Record the wipe, or close it as returned to the owner.',
    {
      field: 'dataWipeCompleted',
      outcome,
      remedy: 'complete the wipe, or return the device to its owner',
    },
  )
}

/**
 * Validates a close in one place, so the repository and the route cannot disagree.
 *
 * Returns the outcome so a caller can use it directly. Everything that must be
 * true of a close is here: the intake is not already closed, the outcome is real,
 * and the data-wipe rule holds. It does not constrain the outcome against the
 * activity, on purpose: an operator who took a phone in for repair and found it
 * unrepairable should be able to close it as recycled or returned, and a second
 * rule that forbade that would only teach operators to record it as something it
 * was not.
 */
export function planClose({ stage, activity, outcome, dataWipeRequested = false, dataWipeCompleted = false }) {
  assertStage(stage)
  assertActivity(activity)
  assertOutcome(outcome)
  if (isClosed(stage)) {
    throw new ConflictError('This intake is already closed.', { stage, outcome })
  }
  assertDataWipeSatisfied({ outcome, dataWipeRequested, dataWipeCompleted })
  return outcome
}
