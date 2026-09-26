import { ConflictError, ValidationError } from './errors.js'

/**
 * Catalogue ingestion and review domain rules.
 *
 * A directory is only worth anything if a person can tell which entries in it are
 * true, and the only honest way to do that is to make the journey from "somebody
 * typed this" to "the public can find this" a pipeline with named steps, each one
 * owned by somebody and each one written down. That is what this module is: the
 * vocabulary for the journey, the rules about which step may follow which, and
 * the single rule that decides what the public may see.
 *
 * The rules are pure functions with no database and no clock, which is what lets
 * the api layer, the importers and the tests all agree on them without consulting
 * each other.
 */

/**
 * The review lifecycle, in the order a record travels through it.
 *
 * The brief this phase implements is explicit about the states, and the names are
 * kept as they were specified so that a reader holding the specification can map
 * this list onto it line for line. Two of the names carry more weight than they
 * look:
 *
 *   - `under_review` exists so that a reviewer can take ownership of a record.
 *     Without it, "somebody is looking at this" and "this is in the queue" are
 *     the same fact, two reviewers read the same row and both record a decision.
 *   - `approved` is separate from `verified` because they are different claims.
 *     Verified means the facts check out. Approved means this platform is willing
 *     to stand behind the record publicly, which is an editorial decision about
 *     the directory rather than a fact about the business.
 */
export const REVIEW_STATES = Object.freeze([
  'imported',
  'pending_review',
  'under_review',
  'verified',
  'approved',
  'rejected',
  'archived',
])

/** The state a record lands in the moment a controlled source hands it over. */
export const INTAKE_STATE = 'imported'

/** The state every record waits in until a reviewer picks it up. */
export const QUEUE_STATE = 'pending_review'

/**
 * The only state whose records may be read by the public, or matched by public
 * search. Named once, here, so that "approved only" is a single fact in the
 * codebase rather than a predicate repeated in six places.
 */
export const PUBLISHED_STATE = 'approved'

/**
 * What a catalogue source is, and how far it can be trusted.
 *
 * `type` says how the records arrived. `trustLevel` says what may be done with
 * them before a human has looked: a controlled source is one an authorised
 * operator vouches for, so its records enter the review queue rather than the
 * public index, and a community source's records carry the source with them all
 * the way into the review so the reviewer can see where a claim came from.
 */
export const SOURCE_TYPES = Object.freeze([
  'manual',
  'csv',
  'api',
  'partner',
  'survey',
  'web',
])

export const TRUST_LEVELS = Object.freeze(['controlled', 'community', 'unverified'])

/**
 * Review actions, and the state each one lands a record in.
 *
 * Actions rather than states on the wire, because a reviewer says "approve this",
 * not "set verificationState to approved", and because the action is what the
 * audit log should record: `approved` is a result, `approve` is a decision.
 */
export const REVIEW_ACTIONS = Object.freeze({
  // The only action with no way into it: intake is how a record arrives, not a
  // place a record can be moved to, so this is recorded at the moment a source
  // hands something over and is never performable on an existing record.
  import: 'imported',
  claim: 'under_review',
  submit: 'pending_review',
  verify: 'verified',
  approve: 'approved',
  unapprove: 'verified',
  reject: 'rejected',
  archive: 'archived',
  reopen: 'pending_review',
})

/** The action names, for schemas and error messages. */
export const REVIEW_ACTION_NAMES = Object.freeze(Object.keys(REVIEW_ACTIONS))

/**
 * Which state may follow which.
 *
 * This is the whole of the pipeline's control flow, and it is here rather than in
 * a route handler so that an import, a CLI and a test are all bound by it. Note
 * what is not in it: there is no path from any state straight to `approved`
 * except through `verified`, because "somebody checked it" and "we will publish
 * it" are separate claims and the second one must never ride in on the first.
 */
const TRANSITIONS = Object.freeze({
  imported: ['pending_review', 'under_review', 'rejected', 'archived'],
  pending_review: ['under_review', 'rejected', 'archived'],
  under_review: ['verified', 'rejected', 'archived', 'pending_review'],
  verified: ['approved', 'rejected', 'archived', 'under_review'],
  approved: ['verified', 'rejected', 'archived'],
  rejected: ['pending_review', 'archived'],
  archived: ['pending_review', 'archived'],
})

export function assertReviewState(state) {
  if (!REVIEW_STATES.includes(state)) {
    throw new ValidationError(`Unknown review state "${state}".`, {
      allowed: REVIEW_STATES,
    })
  }
  return state
}

export function assertSourceType(type) {
  if (!SOURCE_TYPES.includes(type)) {
    throw new ValidationError(`Unknown source type "${type}".`, {
      allowed: SOURCE_TYPES,
    })
  }
  return type
}

export function assertTrustLevel(level) {
  if (!TRUST_LEVELS.includes(level)) {
    throw new ValidationError(`Unknown trust level "${level}".`, {
      allowed: TRUST_LEVELS,
    })
  }
  return level
}

export function assertReviewAction(action) {
  if (!Object.hasOwn(REVIEW_ACTIONS, action)) {
    throw new ValidationError(`Unknown review action "${action}".`, {
      allowed: REVIEW_ACTION_NAMES,
    })
  }
  return action
}

/** The state an action moves a record to, whatever state it is in now. */
export function targetStateFor(action) {
  return REVIEW_ACTIONS[assertReviewAction(action)]
}

export function allowedTransitions(from) {
  return TRANSITIONS[assertReviewState(from)] ?? []
}

export function canTransition(from, to) {
  return allowedTransitions(from).includes(to)
}

/**
 * The outcome a source's claim may have, when a record enters the queue.
 *
 * A source can say a business exists, but it cannot verify one and it certainly
 * cannot approve one: publishing is this platform's decision, made by a person
 * here. So the highest a record can arrive at is `verified`, and an import that
 * claims more than that is not being obeyed, it is being recorded.
 */
export const INTAKE_CEILING = 'verified'

/**
 * What a state claimed by a source becomes on intake.
 *
 * Written as an explicit table rather than as an ordering comparison, because the
 * states are not evenly spaced: `under_review` is somebody's ownership, and
 * `rejected` is somebody's decision, so neither means anything when it arrives in
 * a spreadsheet column. Both land in the queue instead.
 */
const INTAKE_BY_CLAIM = Object.freeze({
  imported: 'imported',
  pending_review: 'pending_review',
  under_review: 'pending_review',
  verified: 'verified',
  approved: 'verified',
  rejected: 'imported',
  archived: 'imported',
})

/** Clamps a state claimed by a source to the highest one it is allowed to assert. */
export function clampIntakeState(claimed) {
  if (!claimed) return INTAKE_STATE
  assertReviewState(claimed)
  return INTAKE_BY_CLAIM[claimed] ?? INTAKE_STATE
}

/**
 * Refuses a create that asks to be born approved.
 *
 * The rule is deliberately a refusal rather than a clamp. Clamping would be
 * convenient, but it would mean an api client that posted `approved` got back a
 * `201` for a record that is not approved, and would only find out when somebody
 * searched for it and it was not there. A refusal is a louder and cheaper mistake.
 */
export function assertIntakeState(state) {
  assertReviewState(state)
  if (state !== INTAKE_STATE && state !== QUEUE_STATE) {
    throw new ValidationError(
      `A new record cannot be created as ${labelFor(state)}. ` +
        'Records enter the pipeline as imported or waiting for review, and reach ' +
        'the published states through review actions.',
      { field: 'verificationState', allowed: [INTAKE_STATE, QUEUE_STATE] },
    )
  }
  return state
}

/**
 * Refuses an impossible move, and says which move was legal.
 *
 * A 409 rather than a 400: the request is well formed, the record simply is not
 * in a state that allows this, which is a conflict with the world rather than a
 * mistake in the payload. Naming the legal moves is deliberate — a client that
 * tries `approve` on a record still sitting in the queue should be able to fix
 * itself without a second round trip and without a human reading the log.
 */
export function assertTransition(from, to) {
  assertReviewState(from)
  assertReviewState(to)
  if (from === to) {
    throw new ConflictError(`This record is already ${labelFor(to)}.`, {
      from,
      to,
    })
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `A record cannot go from ${labelFor(from)} to ${labelFor(to)}.`,
      { from, to, allowed: allowedTransitions(from) },
    )
  }
  return to
}

/** The states a reviewer is expected to work through, in pipeline order. */
export const PIPELINE_ORDER = Object.freeze([
  'imported',
  'pending_review',
  'under_review',
  'verified',
  'approved',
])

/** The states a record can be sent back from, i.e. the ones that end a listing. */
export const TERMINAL_STATES = Object.freeze(['rejected', 'archived'])

/**
 * The states a record can be verified from without somebody claiming it first.
 *
 * `under_review` is an ownership state rather than a decision, so a reviewer who
 * opens a record and verifies it in one go has still claimed it, and the recorded
 * journey says so. That is the whole reason `verify` is allowed to pass through
 * here: it keeps the common single-reviewer case to one click without letting the
 * record skip a step it actually took.
 */
const UNCLAIMED_STATES = Object.freeze([INTAKE_STATE, QUEUE_STATE])

/**
 * The steps an action performs, in order, or null if it cannot be performed.
 *
 * Returning the steps rather than a target state is what lets one atomic write
 * record a claim and a decision in the same transaction, and what lets the same
 * rule answer "which buttons should this page show" without being asked twice.
 */
export function reviewPlan(from, action) {
  assertReviewState(from)
  assertReviewAction(action)
  const target = REVIEW_ACTIONS[action]

  const steps = []
  let cursor = from
  if (action === 'verify' && UNCLAIMED_STATES.includes(cursor)) {
    steps.push({ from: cursor, to: 'under_review', action: 'claim' })
    cursor = 'under_review'
  }
  if (from === target || !canTransition(cursor, target)) return null
  steps.push({ from: cursor, to: target, action })
  return steps
}

/** The actions available on a record in a given state. What the review ui reads. */
export function legalActions(from) {
  assertReviewState(from)
  return REVIEW_ACTION_NAMES.filter((action) => reviewPlan(from, action) !== null)
}

/** The action that would move a record to a state, or null if none would. */
export function actionFor(from, to) {
  assertReviewState(from)
  assertReviewState(to)
  if (from === to) return null
  for (const action of REVIEW_ACTION_NAMES) {
    const plan = reviewPlan(from, action)
    if (plan && plan[plan.length - 1].to === to) return action
  }
  return null
}

/**
 * Human wording for a state, used in messages the operator reads.
 *
 * Deliberately not a title-case transform of the stored value: "under review" is
 * what a person says, and the underscore form is a storage detail.
 */
const STATE_LABELS = Object.freeze({
  imported: 'imported',
  pending_review: 'waiting for review',
  under_review: 'under review',
  verified: 'verified',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
})

export function labelFor(state) {
  return STATE_LABELS[state] ?? state
}
