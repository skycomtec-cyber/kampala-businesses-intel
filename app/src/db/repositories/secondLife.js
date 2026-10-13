import { newId } from '../../core/identifiers.js'
import {
  assertActivity,
  assertDeviceType,
  assertReceivedCondition,
  assertStage,
  assertAdvance,
  nextStages,
  isClosed,
  planClose,
  categorySlugForActivity,
  INTAKE_OPENING_STAGE,
  INTAKE_CLOSED_STAGE,
  INTAKE_STAGES,
  INTAKE_OUTCOMES,
  SECOND_LIFE_ACTIVITIES,
} from '../../core/secondLife.js'
import { NotFoundError } from '../../core/errors.js'
import {
  camelizeRow,
  camelizeRows,
  nowIso,
  toSqlBool,
  fromSqlBool,
} from '../mapping.js'
import { normalisePagination, where, likeParam, resolveOrder } from './common.js'

/**
 * Device intake, the operational record behind the Second Life Electronics
 * vertical.
 *
 * The shape of this repository mirrors the marketplace one deliberately: a
 * human-facing reference, a row plus an append-only event table, and a status move
 * that writes both in one transaction. What is different is what the row is about.
 * A request is demand that may or may not be met; an intake is a physical device
 * that definitely exists and definitely leaves in some state, and the platform is
 * only useful if it can say which state.
 *
 * Two invariants are enforced below rather than trusted:
 *
 *   - The stage only ever moves forward, through `core/secondLife.js`, never by a
 *     direct UPDATE from a caller.
 *   - A close names an outcome, and the data-wipe rule is checked before the
 *     write, so a device holding un-wiped data cannot be recorded as having left.
 */

const INTAKE_COLUMNS = `
  id, reference, business_id, category_id, activity, device_type,
  received_condition, make, model, quantity, stage, outcome,
  data_wipe_requested, data_wipe_completed, owner_ref, notes,
  closed_at, created_at, updated_at
`

const LIST_SORTS = Object.freeze({
  newest: 'di.created_at DESC',
  oldest: 'di.created_at ASC',
  reference: 'di.reference ASC',
})

export function createSecondLifeRepository(db, config) {
  const insert = db.prepare(
    `INSERT INTO device_intake (
       id, reference, business_id, category_id, activity, device_type,
       received_condition, make, model, quantity, stage, outcome,
       data_wipe_requested, data_wipe_completed, owner_ref, notes
     ) VALUES (
       @id, @reference, @businessId, @categoryId, @activity, @deviceType,
       @receivedCondition, @make, @model, @quantity, @stage, @outcome,
       @dataWipeRequested, @dataWipeCompleted, @ownerRef, @notes
     )`,
  )
  const selectById = db.prepare(`SELECT ${INTAKE_COLUMNS} FROM device_intake WHERE id = ?`)
  const selectByReference = db.prepare(
    `SELECT ${INTAKE_COLUMNS} FROM device_intake WHERE reference = ?`,
  )
  const selectCountForYear = db.prepare(
    `SELECT COUNT(*) AS total FROM device_intake WHERE created_at >= ?`,
  )
  const updateStage = db.prepare(
    `UPDATE device_intake SET stage = @stage, updated_at = @now WHERE id = @id`,
  )
  const closeRow = db.prepare(
    `UPDATE device_intake
        SET stage = @stage, outcome = @outcome, data_wipe_completed = @dataWipeCompleted,
            closed_at = @now, updated_at = @now
      WHERE id = @id`,
  )
  const completeWipeRow = db.prepare(
    `UPDATE device_intake
        SET data_wipe_completed = 1, updated_at = @now
      WHERE id = @id`,
  )
  const insertEvent = db.prepare(
    `INSERT INTO device_intake_event (
       id, intake_id, from_stage, to_stage, outcome, actor_id, note
     ) VALUES (
       @id, @intakeId, @fromStage, @toStage, @outcome, @actorId, @note
     )`,
  )
  const selectEvents = db.prepare(
    `SELECT * FROM device_intake_event WHERE intake_id = ? ORDER BY created_at ASC`,
  )
  const countByStage = db.prepare(
    `SELECT stage, COUNT(*) AS total FROM device_intake
      WHERE (@businessId IS NULL OR business_id = @businessId)
      GROUP BY stage`,
  )
  const countByOutcome = db.prepare(
    `SELECT outcome, COUNT(*) AS total FROM device_intake
      WHERE outcome IS NOT NULL AND (@businessId IS NULL OR business_id = @businessId)
      GROUP BY outcome`,
  )
  const countByActivity = db.prepare(
    `SELECT activity, COUNT(*) AS total FROM device_intake
      WHERE (@businessId IS NULL OR business_id = @businessId)
      GROUP BY activity`,
  )
  const countWipes = db.prepare(
    `SELECT
        SUM(CASE WHEN data_wipe_requested = 1 THEN 1 ELSE 0 END) AS requested,
        SUM(CASE WHEN data_wipe_requested = 1 AND data_wipe_completed = 1 THEN 1 ELSE 0 END) AS completed
       FROM device_intake
      WHERE (@businessId IS NULL OR business_id = @businessId)`,
  )

  function intakeRow(row) {
    const record = camelizeRow(row)
    record.dataWipeRequested = fromSqlBool(record.dataWipeRequested)
    record.dataWipeCompleted = fromSqlBool(record.dataWipeCompleted)
    return record
  }

  function requireRow(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('DeviceIntake', id)
    return row
  }

  /**
   * Human-facing reference, e.g. SL-2026-00042.
   *
   * Generated inside the insert's transaction, with the year in the prefix, for
   * the same reason the marketplace does it: a number read off a paper docket
   * eighteen months from now has to still resolve.
   */
  function nextReference(at) {
    const year = new Date(at).getUTCFullYear()
    const total = selectCountForYear.get(`${year}-01-01T00:00:00.000Z`).total
    return `SL-${year}-${String(total + 1).padStart(5, '0')}`
  }

  const repository = {
    /**
     * Takes a device in.
     *
     * The category is resolved from the activity when the caller does not name
     * one, so an operator who records "repair" gets the device-repair subcategory
     * without having to know its id. A caller that does name a category keeps it,
     * which is what lets a parts-recovery job be filed under repair when that is
     * genuinely where it belongs.
     */
    create(input) {
      const activity = assertActivity(input.activity)
      const deviceType = assertDeviceType(input.deviceType)
      const receivedCondition = assertReceivedCondition(input.receivedCondition)
      const quantity = Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 1
      const at = input.at ?? nowIso()
      const id = newId()
      const dataWipeRequested = Boolean(input.dataWipeRequested)

      const write = db.transaction(() => {
        insert.run({
          id,
          reference: nextReference(at),
          businessId: input.businessId,
          categoryId: input.categoryId ?? null,
          activity,
          deviceType,
          receivedCondition,
          make: input.make ?? null,
          model: input.model ?? null,
          quantity,
          stage: INTAKE_OPENING_STAGE,
          outcome: null,
          dataWipeRequested: toSqlBool(dataWipeRequested),
          // A wipe cannot be completed at the moment it is requested. The two are
          // different facts and the whole rule depends on the gap between them.
          dataWipeCompleted: toSqlBool(false),
          ownerRef: input.ownerRef ?? null,
          notes: input.notes ?? null,
        })
        insertEvent.run({
          id: newId(),
          intakeId: id,
          fromStage: null,
          toStage: INTAKE_OPENING_STAGE,
          outcome: null,
          actorId: input.actorId ?? null,
          note: 'Device taken in.',
        })
      })
      write()

      return repository.requireById(id)
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? intakeRow(row) : null
    },

    findByReference(reference) {
      const row = selectByReference.get(reference)
      return row ? intakeRow(row) : null
    },

    requireById(id) {
      return intakeRow(requireRow(id))
    },

    requireByReference(reference) {
      const row = selectByReference.get(reference)
      if (!row) throw new NotFoundError('DeviceIntake', reference)
      return intakeRow(row)
    },

    /** An intake with its full stage history. */
    detail(id) {
      const intake = repository.requireById(id)
      return {
        ...intake,
        events: camelizeRows(selectEvents.all(id)),
        // The legal next moves are part of the read rather than something a client
        // re-derives, so the ui and the api cannot disagree about what is allowed.
        nextStages: nextStages(intake.stage),
        categorySlug: categorySlugForActivity(intake.activity),
      }
    },

    list({
      businessId = null,
      stage = null,
      outcome = null,
      activity = null,
      deviceType = null,
      search = null,
      sort = 'newest',
      limit,
      offset,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}

      if (businessId) {
        conditions.push('di.business_id = @businessId')
        params.businessId = businessId
      }
      if (stage) {
        conditions.push('di.stage = @stage')
        params.stage = assertStage(stage)
      }
      if (outcome) {
        conditions.push('di.outcome = @outcome')
        params.outcome = outcome
      }
      if (activity) {
        conditions.push('di.activity = @activity')
        params.activity = assertActivity(activity)
      }
      if (deviceType) {
        conditions.push('di.device_type = @deviceType')
        params.deviceType = assertDeviceType(deviceType)
      }
      if (search) {
        conditions.push(
          "(di.reference LIKE @search ESCAPE '\\' OR di.make LIKE @search ESCAPE '\\' " +
            "OR di.model LIKE @search ESCAPE '\\' OR di.owner_ref LIKE @search ESCAPE '\\')",
        )
        params.search = likeParam(search)
      }

      const whereSql = where(conditions)
      const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)
      const rows = db
        .prepare(
          `SELECT ${INTAKE_COLUMNS} FROM device_intake di
            ${whereSql}
            ORDER BY ${order}, di.id ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM device_intake di ${whereSql}`)
        .get(params).total

      return { total, items: rows.map(intakeRow) }
    },

    /**
     * Moves an intake forward a stage.
     *
     * `assertAdvance` is the only thing that may set a stage, and it refuses a
     * backward move, a no-op and a move straight to `closed`. The stage and its
     * event are written together, so the history can never be missing the row
     * that explains the current value.
     */
    advance(id, to, { actorId = null, note = null } = {}) {
      const current = repository.requireById(id)
      // assertAdvance owns the rule and names the legal moves when it refuses.
      const next = assertAdvance(current.stage, to)

      const write = db.transaction(() => {
        updateStage.run({ id, stage: next, now: nowIso() })
        insertEvent.run({
          id: newId(),
          intakeId: id,
          fromStage: current.stage,
          toStage: next,
          outcome: null,
          actorId,
          note,
        })
      })
      write()
      return repository.requireById(id)
    },

    /**
     * Closes an intake with an outcome.
     *
     * The data-wipe rule lives in `planClose`, and it is applied before the write,
     * so an intake cannot be recorded as having left the business while a wipe it
     * asked for is outstanding. Closing also folds in a wipe completed at the same
     * moment, because an operator finishing the wipe and the job in one step should
     * not need two calls.
     */
    close(id, outcome, { actorId = null, note = null, dataWipeCompleted = false } = {}) {
      const current = repository.requireById(id)
      // A wipe can only be recorded done on an intake that asked for one. The
      // schema enforces the same thing (`completed` implies `requested`), and a
      // caller passing `dataWipeCompleted` for an intake that never needed a wipe
      // is honoured as "nothing to do" rather than turned into a constraint error.
      const completed =
        current.dataWipeCompleted ||
        (current.dataWipeRequested && Boolean(dataWipeCompleted))
      const planned = planClose({
        stage: current.stage,
        activity: current.activity,
        outcome,
        dataWipeRequested: current.dataWipeRequested,
        dataWipeCompleted: completed,
      })

      const write = db.transaction(() => {
        closeRow.run({
          id,
          stage: INTAKE_CLOSED_STAGE,
          outcome: planned,
          dataWipeCompleted: toSqlBool(completed),
          now: nowIso(),
        })
        insertEvent.run({
          id: newId(),
          intakeId: id,
          fromStage: current.stage,
          toStage: INTAKE_CLOSED_STAGE,
          outcome: planned,
          actorId,
          note,
        })
      })
      write()
      return repository.requireById(id)
    },

    /**
     * Records that a requested wipe was carried out, without closing the intake.
     *
     * Separate from `close` because the wipe often happens well before the device
     * is finished, and forcing the two together would make operators either lie
     * about the stage or lie about the wipe.
     */
    completeWipe(id, { actorId = null, note = null } = {}) {
      const current = repository.requireById(id)
      if (current.dataWipeCompleted) return current

      const write = db.transaction(() => {
        completeWipeRow.run({ id, now: nowIso() })
        insertEvent.run({
          id: newId(),
          intakeId: id,
          fromStage: current.stage,
          toStage: current.stage,
          outcome: null,
          actorId,
          note: note ?? 'Data wipe completed.',
        })
      })
      write()
      return repository.requireById(id)
    },

    events(id) {
      return camelizeRows(selectEvents.all(id))
    },

    /**
     * The vertical's numbers.
     *
     * Scoped to a business when one is named and platform-wide otherwise. The wipe
     * pair is reported alongside the outcome counts on purpose: "we took in 400
     * devices and wiped 90 of the 200 that were asked for" is the one line that
     * tells an operator whether the data promise is real, and it is invisible if
     * only the outcomes are counted.
     */
    summary({ businessId = null } = {}) {
      const params = { businessId }
      const stages = zeroed(INTAKE_STAGES, countByStage.all(params))
      const outcomes = zeroed(INTAKE_OUTCOMES, countByOutcome.all(params))
      const activities = zeroed(SECOND_LIFE_ACTIVITIES, countByActivity.all(params))
      const wipes = countWipes.get(params)
      const open = Object.entries(stages)
        .filter(([stage]) => !isClosed(stage))
        .reduce((total, [, count]) => total + count, 0)

      return {
        businessId,
        stages,
        outcomes,
        activities,
        open,
        closed: stages[INTAKE_CLOSED_STAGE] ?? 0,
        dataWipes: {
          requested: wipes?.requested ?? 0,
          completed: wipes?.completed ?? 0,
        },
      }
    },
  }

  return repository
}

/** Turns a `SELECT label, COUNT(*) AS total ... GROUP BY label` result into a full, zero-filled map. */
function zeroed(keys, rows) {
  const result = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const row of rows) {
    const [label, count] = Object.values(row)
    if (label == null) continue
    result[label] = count
  }
  return result
}
