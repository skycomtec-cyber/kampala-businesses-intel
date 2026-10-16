import fs from 'node:fs'
import path from 'node:path'

import { ValidationError } from '../core/errors.js'
import { definePlan } from './plan.js'
import { harvest } from './index.js'

/**
 * The harvest scheduler: which plans are due, and what changed since they ran.
 *
 * A plan is a recipe. This is the clock. Without it a plan is something an
 * operator remembers to run, and a directory maintained by memory is a directory
 * that is accurate exactly as long as the person maintaining it is paying
 * attention to it.
 *
 * Three decisions shape the whole file, and each of them is the opposite of the
 * obvious one.
 *
 * The cadence lives on the plan, not in a scheduler config. A plan that says
 * `"cadenceDays": 30` is a plan that wants to be re-read monthly, and the fact
 * travels with the plan into whatever environment runs it. A schedule kept beside
 * the plans instead drifts the moment a plan is copied or renamed, and leaves two
 * files that have to agree with no way to check that they do.
 *
 * Due-ness is measured against the plan's *own* last completed run. A plan is
 * identified to the catalogue by `(source, batchRef)`, so two plans reading one
 * source on different cadences do not reset each other's clock. And only a
 * completed run counts: a failed harvest did not refresh the source, so treating
 * it as recent would let a source that fails every night be considered fresh
 * forever.
 *
 * The diff is against the previous run of the same plan, computed from a snapshot
 * taken *before* the new run. It has to be, because provenance is upserted on
 * `(source, external_ref)` and each upsert moves the row's `run_id` onto the run
 * that most recently saw it. Once the new run has read a reference, that
 * reference no longer points at the run that saw it last, so a diff assembled
 * afterwards would report every unchanged reference as one the old run never had.
 *
 * Nothing here is automatic. The scheduler runs because a timer or an operator
 * invokes it, and it harvests only the plans that asked for a cadence. A plan
 * that never declares one is a manual plan and is left alone.
 */

const DAY_MS = 86400000

/**
 * The cadence ceiling, mirrored from the plan validator. Kept here so the due
 * check and the plan schema cannot disagree about what a valid cadence is.
 */
const MAX_CADENCE_DAYS = 365

const PLAN_EXTENSION = '.json'

/**
 * Finds every plan file under a directory, recursively and in a stable order.
 *
 * Recursive because plans are grouped a directory per source, which keeps a
 * growing set of plans legible in a file listing and lets one source's plans be
 * reviewed together. Sorted because a scheduled job's log is only diffable
 * between runs if the order is the same every time.
 */
export function planFiles(plansDir) {
  const root = path.resolve(plansDir)
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(PLAN_EXTENSION)) found.push(full)
    }
  }
  if (!fs.existsSync(root)) return []
  walk(root)
  return found.sort((a, b) => a.localeCompare(b))
}

/**
 * Parses and validates every plan in a directory.
 *
 * A plan that does not validate is reported as an entry with an `error`, not
 * thrown. One malformed plan in a directory of twenty must not stop the other
 * nineteen from being re-harvested, and it must not stop being visible either:
 * "this plan is broken" is a thing the operator needs told, on every run, until
 * it is fixed.
 *
 * @returns {Array<{file: string, path: string, sourceKey: string|null, plan: object|null, error: string|null}>}
 */
export function discoverPlans(plansDir) {
  const root = path.resolve(plansDir)
  return planFiles(root).map((file) => {
    const fileLabel = path.relative(root, file).split(path.sep).join('/')
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const plan = definePlan(raw, { filename: fileLabel })
      return { file: fileLabel, path: file, sourceKey: plan.sourceKey, plan, error: null }
    } catch (error) {
      return { file: fileLabel, path: file, sourceKey: null, plan: null, error: error.message }
    }
  })
}

/**
 * Whether a scheduled plan is due to run again.
 *
 * Pure, so the rule can be tested against a fixed clock rather than by waiting.
 * Never harvested is always due: a plan that has opted into a cadence has
 * declared the first run should happen, and there is no previous run to compare
 * against. A last-run time that cannot be parsed is also treated as due, on the
 * principle that a source is better read once too often than never again because
 * a timestamp was malformed.
 */
export function isPlanDue({ lastRunAt = null, cadenceDays, now = new Date() } = {}) {
  if (!Number.isInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > MAX_CADENCE_DAYS) {
    throw new ValidationError(
      `A harvest cadence must be a whole number of days from 1 to ${MAX_CADENCE_DAYS}, got ${cadenceDays}.`,
    )
  }
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= cadenceDays * DAY_MS
}

/**
 * The change in what a source described, between two runs of one plan.
 *
 * Sets of references, so "added", "removed" and "unchanged" are exact and the
 * answer does not depend on row order. Sorted, because a diff a reviewer reads
 * should be stable from run to run, and sets do not promise an order.
 *
 * This is deliberately not a field-level diff. The catalogue stores provenance
 * (which reference came from which source) but not a snapshot of every field a
 * previous run saw, so "this business's phone number changed" is not answerable
 * from what is kept. Reference-level membership is, and it is the question that
 * matters for a source that adds and drops listings over time.
 */
export function diffRunReferences(previousRefs = [], currentRefs = [], { firstRun = false } = {}) {
  const previous = new Set(previousRefs)
  const current = new Set(currentRefs)
  const added = [...current].filter((ref) => !previous.has(ref)).sort()
  const removed = [...previous].filter((ref) => !current.has(ref)).sort()
  const unchanged = [...current].filter((ref) => previous.has(ref)).length
  return {
    firstRun,
    added,
    removed,
    unchanged,
    previousCount: previous.size,
    currentCount: current.size,
  }
}

/**
 * Harvests every due plan, and reports what each one did.
 *
 * The `app` handle is required because two things here are questions about the
 * catalogue, not about the filesystem: whether a plan's source is registered, and
 * when the plan last ran. A plan whose source is not registered is reported
 * failed rather than fetched — the importer would refuse it anyway, and
 * discovering that after pulling a site down is a wasted request against a third
 * party.
 *
 * `transport` is threaded through to the harvest so a caller (a test, or an
 * offline replay) can supply one, exactly as `harvest` itself does.
 *
 * @param {object} app the open database handle and repositories
 * @param {object} [options]
 * @param {string} [options.plansDir='plans'] the directory of plan files
 * @param {Date} [options.now] the clock, injected so a run is reproducible
 * @param {boolean} [options.dryRun] report what is due and change nothing
 * @param {boolean} [options.all] harvest every scheduled plan, ignoring due-ness
 * @param {string|null} [options.fromDir] read saved pages from a local mirror
 * @param {object} [options.transport] a transport for a live read, for tests
 * @param {string|null} [options.archiveRoot] where a live run's pages are archived
 * @param {string} [options.batchDir='./harvest-batches'] where batch files are written
 * @param {object} [options.actor] the actor the runs are attributed to
 * @param {(result: object) => void} [options.onPlan] called after each plan
 * @returns {Promise<object>} the run report
 */
export async function runScheduledHarvests(app, options = {}) {
  const {
    plansDir = 'plans',
    now = new Date(),
    dryRun = false,
    all = false,
    fromDir = null,
    transport = undefined,
    archiveRoot = null,
    batchDir = './harvest-batches',
    actor = null,
    onPlan = null,
  } = options

  if (!app?.catalogue) {
    throw new ValidationError('The harvest scheduler needs a database handle. Pass `app` or run via the CLI.')
  }

  const entries = discoverPlans(plansDir)
  const results = []

  const record = (result) => {
    results.push(result)
    onPlan?.(result)
    return result
  }

  for (const entry of entries) {
    const base = {
      file: entry.file,
      sourceKey: entry.plan?.sourceKey ?? null,
      batchRef: entry.plan?.batchRef ?? null,
      cadenceDays: entry.plan?.cadenceDays ?? null,
    }

    if (!entry.plan) {
      record({ ...base, status: 'invalid', error: entry.error })
      continue
    }

    // A plan with no cadence is a manual plan. The scheduler reports it as left
    // alone rather than silently dropping it, so the plan list in a run's log is
    // the whole list and not only the scheduled part of it.
    if (entry.plan.cadenceDays === null) {
      record({ ...base, status: 'manual' })
      continue
    }

    const source = app.catalogue.findSourceByKey(entry.plan.sourceKey)
    if (!source) {
      record({
        ...base,
        status: 'failed',
        error:
          `Catalogue source "${entry.plan.sourceKey}" is not registered, so this plan ` +
          'cannot be harvested. Register the source first.',
      })
      continue
    }

    const lastRun = app.catalogue.latestCompletedRunForPlan(source.id, {
      batchRef: entry.plan.batchRef ?? null,
    })
    const lastRunAt = lastRun?.finishedAt ?? lastRun?.startedAt ?? null
    const due = all || isPlanDue({ lastRunAt, cadenceDays: entry.plan.cadenceDays, now })

    if (!due) {
      record({
        ...base,
        status: 'skipped',
        reason: 'not-due',
        lastRunAt,
        lastRunId: lastRun?.id ?? null,
        nextDueAt: nextDueAt(lastRunAt, entry.plan.cadenceDays),
      })
      continue
    }

    if (dryRun) {
      record({
        ...base,
        status: 'due',
        lastRunAt,
        lastRunId: lastRun?.id ?? null,
        firstRun: !lastRun,
      })
      continue
    }

    // Snapshot the previous run's references before the new run can move them.
    // See the note at the top of the file: this ordering is the whole reason the
    // diff is correct.
    const previousRefs = lastRun ? app.catalogue.runReferences(lastRun.id) : []

    const runArchiveRoot = archiveRoot
      ? path.join(
          path.resolve(archiveRoot),
          archiveSegment(entry.plan.sourceKey),
          `${archiveSegment(entry.plan.batchRef ?? 'batch')}-${runStamp(now)}`,
        )
      : null

    try {
      const harvested = await harvest(app, entry.plan, {
        transport,
        fromDir,
        mirrorOut: runArchiveRoot,
        outputDir: batchDir,
        batchRef: entry.plan.batchRef ?? null,
        actor,
      })
      const currentRun = harvested.import?.run ?? null
      const currentRefs = currentRun ? app.catalogue.runReferences(currentRun.id) : []
      record({
        ...base,
        status: 'harvested',
        lastRunAt,
        runId: currentRun?.id ?? null,
        summary: harvested.import?.summary ?? null,
        reconciliation: harvested.import?.reconciliation ?? null,
        archiveRoot: harvested.archiveRoot,
        files: harvested.files ?? null,
        diff: diffRunReferences(previousRefs, currentRefs, { firstRun: !lastRun }),
      })
    } catch (error) {
      record({
        ...base,
        status: 'failed',
        lastRunAt,
        error: error.message,
        details: error.details ?? null,
      })
    }
  }

  const count = (status) => results.filter((result) => result.status === status).length
  return {
    now: now.toISOString(),
    plansDir: path.resolve(plansDir),
    dryRun,
    all,
    discovered: entries.length,
    scheduled: results.filter((r) => r.status !== 'manual' && r.status !== 'invalid').length,
    harvested: count('harvested'),
    due: count('due'),
    skipped: count('skipped'),
    failed: count('failed'),
    invalid: count('invalid'),
    manual: count('manual'),
    results,
  }
}

/** The next time a plan becomes due, or null when it has never run. */
function nextDueAt(lastRunAt, cadenceDays) {
  if (!lastRunAt) return null
  const last = Date.parse(lastRunAt)
  if (Number.isNaN(last)) return null
  return new Date(last + cadenceDays * DAY_MS).toISOString()
}

/**
 * A filesystem-safe path segment.
 *
 * A source key is already a slug and a batch reference is usually one, but a
 * batch reference is free text — the shipped plans use `web-mirror/<name>` — and a
 * `/` in it would silently create a subdirectory that the mirror layout below
 * would then be written inside. So anything that is not a letter, a digit, a dash
 * or an underscore becomes a dash.
 */
function archiveSegment(value) {
  return String(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed'
}

/** A timestamp safe to use as a directory name on every platform. */
function runStamp(now) {
  return now.toISOString().replace(/[:.]/g, '-')
}
