import { newId, slugify, disambiguateSlug } from '../../core/identifiers.js'
import {
  INTAKE_STATE,
  QUEUE_STATE,
  assertSourceType,
  assertTrustLevel,
  assertReviewState,
  reviewPlan,
  legalActions,
  labelFor,
} from '../../core/catalogue.js'
import { ValidationError, ConflictError, NotFoundError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso, toSqlBool, fromSqlBool } from '../mapping.js'
import { normalisePagination, resolveOrder } from './common.js'

/**
 * The catalogue layer: sources, provenance, and the record of review.
 *
 * Three questions are answered here, and they are the three a directory has to be
 * able to answer about any listing in it:
 *
 *   1. Where did this come from? (`record_provenance`, one row per origin, so a
 *      record two sources have both described has two answers rather than one lossy
 *      string)
 *   2. Who vouched for that source, and how much does that count for?
 *      (`catalogue_source.trust_level`, which lets a controlled source carry more
 *      weight than a community one without either being discarded)
 *   3. Who decided this record was true, when, and why? (`review_event`, the
 *      journey in pipeline order, which survives every edit made afterwards)
 *
 * The businesses repository owns the record's own row and its search documents.
 * This one owns the paper trail around it, and the one place the two must write
 * together — intake — is a single transaction here that calls into businesses,
 * because a record that exists without its provenance is a record nobody can
 * account for.
 */

const SOURCE_SORTS = Object.freeze({
  name: 'name ASC',
  'name desc': 'name DESC',
  trust: 'trust_level ASC, name ASC',
  newest: 'created_at DESC',
  updated: 'updated_at DESC',
})

/**
 * What the queue needs on every row.
 *
 * The source and the reviewer are joined in rather than looked up per row, because
 * a page of the queue is one screen an operator reads while making twenty
 * decisions, and twenty extra requests is a queue nobody works through.
 */
const QUEUE_COLUMNS = `
  b.id, b.name, b.slug, b.status, b.verification_state, b.capability_level,
  b.catalogue_source_id, b.review_owner_id, b.review_claimed_at,
  b.created_at, b.updated_at, b.category_id, b.primary_location_id,
  s.key AS source_key, s.name AS source_name, s.trust_level AS source_trust_level,
  u.display_name AS owner_display_name
`

export function createCatalogueRepository(db, deps = {}) {
  const { businesses, audit } = deps

  const insertSource = db.prepare(
    `INSERT INTO catalogue_source (
       id, key, name, type, trust_level, owner, uri, licence, notes, is_active
     ) VALUES (
       @id, @key, @name, @type, @trustLevel, @owner, @uri, @licence, @notes, @isActive
     )`,
  )
  const updateSource = db.prepare(
    `UPDATE catalogue_source
        SET name = @name,
            type = @type,
            trust_level = @trustLevel,
            owner = @owner,
            uri = @uri,
            licence = @licence,
            notes = @notes,
            is_active = @isActive,
            updated_at = @now
      WHERE id = @id`,
  )
  const selectSourceById = db.prepare(`SELECT * FROM catalogue_source WHERE id = ?`)
  const selectSourceByKey = db.prepare(`SELECT * FROM catalogue_source WHERE key = ?`)
  const selectSourceKeyExists = db.prepare(
    `SELECT 1 AS present FROM catalogue_source WHERE key = ?`,
  )
  const selectAllSources = db.prepare(
    `SELECT * FROM catalogue_source ORDER BY is_active DESC, name ASC`,
  )
  const countSources = db.prepare(
    `SELECT COUNT(*) AS total FROM catalogue_source
      WHERE (@type IS NULL OR type = @type)
        AND (@trustLevel IS NULL OR trust_level = @trustLevel)
        AND (@isActive IS NULL OR is_active = @isActive)`,
  )
  const countSourceRecordsOne = db.prepare(
    `SELECT COUNT(*) AS total FROM record_provenance WHERE source_id = ?`,
  )
  // A source that has fed four hundred records into the queue and taken none out
  // of the other end has stopped being a source of supply and become a backlog, so
  // this is the number that says which of the two it is.
  const countSourcePendingOne = db.prepare(
    `SELECT COUNT(*) AS total
       FROM record_provenance p
       JOIN business b ON b.id = p.business_id
      WHERE p.source_id = ?
        AND b.verification_state IN ('imported','pending_review','under_review','verified')`,
  )

  const insertProvenance = db.prepare(
    `INSERT INTO record_provenance (
       id, business_id, source_id, external_ref, batch_ref, evidence, notes,
       imported_at, imported_by, run_id
     ) VALUES (
       @id, @businessId, @sourceId, @externalRef, @batchRef, @evidence, @notes,
       @importedAt, @importedBy, @runId
     )`,
  )
  // The conflict target repeats the partial index's WHERE clause, because that is
  // what makes it the same index: an upsert that named only the columns would
  // match no unique constraint at all, and SQLite says so at prepare time.
  const upsertProvenance = db.prepare(
    `INSERT INTO record_provenance (
       id, business_id, source_id, external_ref, batch_ref, evidence, notes,
       imported_at, imported_by, run_id
     ) VALUES (
       @id, @businessId, @sourceId, @externalRef, @batchRef, @evidence, @notes,
       @importedAt, @importedBy, @runId
     )
     ON CONFLICT (source_id, external_ref) WHERE external_ref IS NOT NULL
     DO UPDATE SET
       business_id = excluded.business_id,
       batch_ref = excluded.batch_ref,
       evidence = excluded.evidence,
       notes = excluded.notes,
       imported_at = excluded.imported_at,
       imported_by = excluded.imported_by,
       run_id = excluded.run_id`,
  )
  const selectProvenanceByBusiness = db.prepare(
    `SELECT p.*, s.key AS source_key, s.name AS source_name, s.type AS source_type,
            s.trust_level AS source_trust_level
       FROM record_provenance p
       JOIN catalogue_source s ON s.id = p.source_id
      WHERE p.business_id = ?
      ORDER BY p.imported_at DESC, p.rowid DESC`,
  )
  const selectProvenanceBySource = db.prepare(
    `SELECT * FROM record_provenance
      WHERE source_id = ?
      ORDER BY imported_at DESC
      LIMIT @limit OFFSET @offset`,
  )
  const selectProvenanceIdentity = db.prepare(
    `SELECT * FROM record_provenance WHERE source_id = ? AND external_ref = ?`,
  )

  /* Harvest runs ------------------------------------------------------------ */

  const insertRun = db.prepare(
    `INSERT INTO catalogue_import_run (
       id, source_id, batch_ref, filename, content_sha256, actor_id,
       status, notes, started_at
     ) VALUES (
       @id, @sourceId, @batchRef, @filename, @contentSha256, @actorId,
       @status, @notes, @startedAt
     )`,
  )
  const finishRun = db.prepare(
    `UPDATE catalogue_import_run
        SET status = @status,
            total = @total,
            created_count = @createdCount,
            updated_count = @updatedCount,
            skipped_count = @skippedCount,
            failed_count = @failedCount,
            notes = COALESCE(@notes, notes),
            finished_at = @finishedAt
      WHERE id = @id`,
  )
  const selectRunById = db.prepare(`SELECT * FROM catalogue_import_run WHERE id = ?`)
  const selectLatestRunForSource = db.prepare(
    `SELECT * FROM catalogue_import_run
      WHERE source_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1`,
  )
  const selectRuns = db.prepare(
    `SELECT r.*, s.key AS source_key, s.name AS source_name,
            u.display_name AS actor_display_name
       FROM catalogue_import_run r
       JOIN catalogue_source s ON s.id = r.source_id
       LEFT JOIN app_user u ON u.id = r.actor_id
      WHERE (@sourceId IS NULL OR r.source_id = @sourceId)
        AND (@status IS NULL OR r.status = @status)
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT @limit OFFSET @offset`,
  )
  const countRuns = db.prepare(
    `SELECT COUNT(*) AS total FROM catalogue_import_run
      WHERE (@sourceId IS NULL OR source_id = @sourceId)
        AND (@status IS NULL OR status = @status)`,
  )
  // The identity a run actually saw. Reconciliation is a set difference against
  // this, so it is read here rather than reconstructed from the run's counts: the
  // counts say how many rows arrived, not which ones.
  const selectRunSeenRefs = db.prepare(
    `SELECT external_ref FROM record_provenance
      WHERE run_id = @runId AND external_ref IS NOT NULL`,
  )
  // A record this source has described before, that this run did not. `p.run_id IS
  // NULL` is included on purpose: the records the source fed in before runs existed
  // are exactly the ones most likely to have gone stale, and excluding them would
  // make reconciliation blind to the backlog it was written for.
  const selectStaleForRun = db.prepare(
    `SELECT p.external_ref, p.batch_ref, p.imported_at, p.run_id,
            b.id AS business_id, b.name AS business_name, b.slug AS business_slug,
            b.verification_state
       FROM record_provenance p
       JOIN business b ON b.id = p.business_id
      WHERE p.source_id = @sourceId
        AND p.external_ref IS NOT NULL
        AND (p.run_id IS NULL OR p.run_id <> @runId)
        AND p.external_ref NOT IN (
          SELECT external_ref FROM record_provenance
           WHERE run_id = @runId AND external_ref IS NOT NULL
        )
      ORDER BY p.imported_at ASC, p.external_ref ASC`,
  )

  const updateBusinessSource = db.prepare(
    `UPDATE business
        SET catalogue_source_id = @sourceId, updated_at = @now
      WHERE id = @id`,
  )
  const insertIntakeEvent = db.prepare(
    `INSERT INTO review_event (
       id, business_id, from_state, to_state, action,
       actor_id, actor_role, reason, source_id, created_at
     ) VALUES (
       @id, @businessId, NULL, @toState, @action,
       @actorId, @actorRole, @reason, @sourceId, @createdAt
     )`,
  )
  const selectEventsByBusiness = db.prepare(
    `SELECT e.*, s.key AS source_key
       FROM review_event e
       LEFT JOIN catalogue_source s ON s.id = e.source_id
      WHERE e.business_id = ?
      ORDER BY e.created_at ASC, e.rowid ASC`,
  )
  const selectRecentEvents = db.prepare(
    `SELECT e.*, b.name AS business_name, b.slug AS business_slug, s.key AS source_key
       FROM review_event e
       JOIN business b ON b.id = e.business_id
       LEFT JOIN catalogue_source s ON s.id = e.source_id
      ORDER BY e.created_at DESC, e.rowid DESC
      LIMIT @limit OFFSET @offset`,
  )
  const countEvents = db.prepare(`SELECT COUNT(*) AS total FROM review_event`)
  const selectQueueRows = db.prepare(
    `SELECT ${QUEUE_COLUMNS}
       FROM business b
       LEFT JOIN app_user u ON u.id = b.review_owner_id
       LEFT JOIN catalogue_source s ON s.id = b.catalogue_source_id
      WHERE (@state IS NULL OR b.verification_state = @state)
        AND (@sourceId IS NULL OR b.catalogue_source_id = @sourceId)
        AND (@ownerId IS NULL OR b.review_owner_id = @ownerId)
        AND (@unclaimed = 0 OR b.review_owner_id IS NULL)
      ORDER BY b.updated_at ASC, b.id ASC
      LIMIT @limit OFFSET @offset`,
  )
  const countQueueRows = db.prepare(
    `SELECT COUNT(*) AS total FROM business b
      WHERE (@state IS NULL OR b.verification_state = @state)
        AND (@sourceId IS NULL OR b.catalogue_source_id = @sourceId)
        AND (@ownerId IS NULL OR b.review_owner_id = @ownerId)
        AND (@unclaimed = 0 OR b.review_owner_id IS NULL)`,
  )
  const countQueueByState = db.prepare(
    `SELECT verification_state, COUNT(*) AS total FROM business
      WHERE verification_state IN ('imported','pending_review','under_review','verified')
      GROUP BY verification_state`,
  )
const selectMissingProvenance = db.prepare(
  `SELECT b.id, b.name, b.slug FROM business b
      WHERE NOT EXISTS (SELECT 1 FROM record_provenance p WHERE p.business_id = b.id)
      ORDER BY b.created_at ASC, b.id ASC
      LIMIT @limit OFFSET @offset`,
  )
  const countMissingProvenance = db.prepare(
    `SELECT COUNT(*) AS total FROM business b
      WHERE NOT EXISTS (SELECT 1 FROM record_provenance p WHERE p.business_id = b.id)`,
  )

  function requireSource(id) {
    const row = selectSourceById.get(id)
    if (!row) throw new NotFoundError('Catalogue source', id)
    return row
  }

  const RUN_STATES = ['running', 'completed', 'failed']

  function assertRunState(state) {
    if (!RUN_STATES.includes(state)) {
      throw new ValidationError(`Unknown run status "${state}".`, {
        field: 'status',
        allowed: RUN_STATES,
      })
    }
    return state
  }

  function requireRun(id) {
    const row = selectRunById.get(id)
    if (!row) throw new NotFoundError('Catalogue import run', id)
    return row
  }

  /**
   * Every read of a source carries its two counts.
   *
   * Not decoration: a source with no record count cannot be triaged, and one with
   * a count that changes shape depending on which method fetched it is a field a
   * caller has to null-check. So `createSource`, `updateSource`, `allSources` and
   * `findSourceById` all return the same shape as `listSources`.
   */
  function sourceRow(row) {
    const record = camelizeRow(row)
    record.isActive = fromSqlBool(record.isActive)
    return attachCounts(record)
  }

  /**
   * A source's key is its identity, and it is derived from its name.
   *
   * There is no disambiguation suffix here, deliberately, unlike a business slug.
   * Two sources called "KampalaBiz Manual Import" are not two sources, they are
   * the same source registered twice, and giving the second one a `-2` key would
   * leave a directory where half the records came from a source that does not
   * exist and nobody ever chose. So a collision returns the source that is already
   * there when the name matches, and is an error when it does not.
   */
  function resolveSourceKey(preferred, name) {
    return slugify(preferred || name)
  }

  /**
   * Validates a source from untrusted input.
   *
   * `existing` makes the same function serve both create and update, so a patch
   * that omits the trust level cannot accidentally reset it to the default and
   * quietly demote a controlled source to unverified — or, worse, promote a
   * community one.
   */
  function buildSource(input, existing = null) {
    const name = String(input.name ?? existing?.name ?? '').trim()
    if (name.length < 2 || name.length > 160) {
      throw new ValidationError('A source name must be 2 to 160 characters.', {
        field: 'name',
      })
    }
    return {
      name,
      type: assertSourceType(input.type ?? existing?.type),
      trustLevel: assertTrustLevel(input.trustLevel ?? existing?.trust_level),
      owner: text(input.owner ?? existing?.owner, 160),
      uri: text(input.uri ?? existing?.uri, 300),
      licence: text(input.licence ?? existing?.licence, 120),
      notes: text(input.notes ?? existing?.notes, 1000),
      isActive:
        input.isActive === undefined
          ? (existing ? fromSqlBool(existing.is_active) : true)
          : Boolean(input.isActive),
    }
  }

  function attachCounts(source) {
    return {
      ...source,
      recordCount: countSourceRecordsOne.get(source.id).total,
      pendingCount: countSourcePendingOne.get(source.id).total,
    }
  }

  const repository = {
    /* Sources ---------------------------------------------------------------- */

    createSource(input) {
      // The name is resolved and looked up before anything else is validated.
      //
      // This order is the whole behaviour: registering a source that already
      // exists returns it, and a caller who sends nothing but the name is asking
      // "is this already registered", not asking to create it with a blank trust
      // level. Validating first answered that question with "Unknown trust level
      // \"undefined\"", which is both wrong and baffling, and it did so on the
      // exact call the seed makes on every start.
      const name = String(input?.name ?? '').trim()
      const key = resolveSourceKey(input?.key, name)
      const existing = selectSourceByKey.get(key)
      if (existing) {
        if (existing.name !== name) {
          throw new ConflictError(
            `A catalogue source with the key "${key}" already exists and is called "${existing.name}".`,
            { key, existingName: existing.name },
          )
        }
        return sourceRow(existing)
      }

      const built = buildSource(input)
      const id = newId()
      insertSource.run({
        id,
        key,
        name: built.name,
        type: built.type,
        trustLevel: built.trustLevel,
        owner: built.owner,
        uri: built.uri,
        licence: built.licence,
        notes: built.notes,
        isActive: toSqlBool(built.isActive),
      })
      return sourceRow(selectSourceById.get(id))
    },

    updateSource(id, patch) {
      const existing = requireSource(id)
      const built = buildSource(patch, existing)
      updateSource.run({
        id,
        name: built.name,
        type: built.type,
        trustLevel: built.trustLevel,
        owner: built.owner,
        uri: built.uri,
        licence: built.licence,
        notes: built.notes,
        isActive: toSqlBool(built.isActive),
        now: nowIso(),
      })
      return sourceRow(selectSourceById.get(id))
    },

    /**
     * Retires a source rather than deleting it.
     *
     * The provenance rows point at it with ON DELETE RESTRICT precisely so that
     * this is the only way a source goes away, and so that "we no longer accept
     * records from here" can never quietly become "we have no idea where these
     * came from".
     */
    retireSource(id) {
      requireSource(id)
      return repository.updateSource(id, { isActive: false })
    },

    findSourceById(id) {
      const row = selectSourceById.get(id)
      return row ? sourceRow(row) : null
    },

    findSourceByKey(key) {
      const row = selectSourceByKey.get(key)
      return row ? sourceRow(row) : null
    },

    requireSourceByKey(key) {
      const row = selectSourceByKey.get(key)
      if (!row) throw new NotFoundError('Catalogue source', key)
      return sourceRow(row)
    },

    requireSourceById(id) {
      const row = selectSourceById.get(id)
      if (!row) throw new NotFoundError('Catalogue source', id)
      return sourceRow(row)
    },

    allSources() {
      return selectAllSources.all().map(sourceRow)
    },

    listSources({ type = null, trustLevel = null, isActive = null, sort = 'name', limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      const params = {
        type: type ? assertSourceType(type) : null,
        trustLevel: trustLevel ? assertTrustLevel(trustLevel) : null,
        isActive: isActive === null || isActive === undefined ? null : isActive ? 1 : 0,
        limit: page.limit,
        offset: page.offset,
      }
      const total = countSources.get(params).total
      const order = resolveOrder(sort, SOURCE_SORTS, SOURCE_SORTS.name)
      const items = db
        .prepare(
          `SELECT * FROM catalogue_source
            WHERE (@type IS NULL OR type = @type)
              AND (@trustLevel IS NULL OR trust_level = @trustLevel)
              AND (@isActive IS NULL OR is_active = @isActive)
            ORDER BY ${order}
            LIMIT @limit OFFSET @offset`,
        )
        .all(params)
        .map(sourceRow)
      return { total, items }
    },

    /** Every source with its record and backlog counts, for the register page. */
    allSourceCounts() {
      return selectAllSources.all().map(sourceRow)
    },

    countsForSource(sourceId) {
      requireSource(sourceId)
      return attachCounts(sourceRow(selectSourceById.get(sourceId)))
    },

    /* Provenance ------------------------------------------------------------- */

    /**
     * Records where a fact about a business came from.
     *
     * Idempotent on (source, externalRef): replaying an import updates the row that
     * is already there rather than stacking a second claim about the same thing.
     * That matters more than it looks, because running a file twice is normal —
     * fixing a typo means re-running it — and a directory that counted one
     * business as twice-sourced would let a single sheet inflate the coverage of a
     * whole category.
     *
     * `attachToBusiness` is false when the provenance is a secondary origin, such
     * as a phone number confirmed by a later survey: that record's denormalised
     * source column has to keep pointing at the source that produced the record,
     * not at whoever last touched a detail on it.
     */
    recordProvenance(
      businessId,
      {
        sourceId,
        externalRef = null,
        batchRef = null,
        evidence = null,
        notes = null,
        importedBy = null,
        importedAt = null,
        runId = null,
        attachToBusiness = true,
      },
    ) {
      requireSource(sourceId)
      businesses.requireById(businessId)
      const params = {
        id: newId(),
        businessId,
        sourceId,
        externalRef: text(externalRef, 200),
        batchRef: text(batchRef, 120),
        evidence: text(evidence, 500),
        notes: text(notes, 1000),
        importedAt: importedAt ?? nowIso(),
        importedBy,
        runId,
      }
      const existing = params.externalRef
        ? selectProvenanceIdentity.get(sourceId, params.externalRef)
        : null
      if (existing) upsertProvenance.run(params)
      else insertProvenance.run(params)
      if (attachToBusiness) {
        updateBusinessSource.run({
          id: businessId,
          sourceId,
          now: params.importedAt,
        })
      }
      return repository.provenanceFor(businessId)
    },

    provenanceFor(businessId) {
      return camelizeRows(selectProvenanceByBusiness.all(businessId))
    },

    provenanceForSource(sourceId, { limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      return camelizeRows(
        selectProvenanceBySource.all(sourceId, {
          limit: page.limit,
          offset: page.offset,
        }),
      )
    },

    /* Harvest runs ----------------------------------------------------------- */

    /**
     * Opens a run before a file is ingested.
     *
     * The row is written first and finished later, deliberately, rather than
     * assembled in memory and written once at the end. A run that is open when the
     * process dies is the honest record of what happened — "this import was
     * started and never finished" — whereas a run written only on success makes a
     * crashed import indistinguishable from one nobody ever ran.
     */
    beginRun({
      sourceId,
      batchRef = null,
      filename = null,
      contentSha256 = null,
      actor = null,
      notes = null,
      startedAt = null,
    }) {
      requireSource(sourceId)
      const id = newId()
      insertRun.run({
        id,
        sourceId,
        batchRef: text(batchRef, 120),
        filename: text(filename, 300),
        contentSha256: text(contentSha256, 64),
        actorId: actor?.id ?? null,
        status: 'running',
        notes: text(notes, 1000),
        startedAt: startedAt ?? nowIso(),
      })
      return repository.findRunById(id)
    },

    /**
     * Closes a run with what it did.
     *
     * `status` is only ever `completed` or `failed` here: a run cannot be closed
     * back into `running`, and the counts are the run's own tally, not a recount of
     * the records, because the records that a failed run did not create are the
     * ones worth being able to see.
     */
    finishRun(
      runId,
      {
        status = 'completed',
        total = 0,
        created = 0,
        updated = 0,
        skipped = 0,
        failed = 0,
        notes = null,
        finishedAt = null,
      } = {},
    ) {
      requireRun(runId)
      if (status !== 'completed' && status !== 'failed') {
        throw new ValidationError(`A run can only finish completed or failed, not "${status}".`, {
          field: 'status',
        })
      }
      finishRun.run({
        id: runId,
        status,
        total: int(total),
        createdCount: int(created),
        updatedCount: int(updated),
        skippedCount: int(skipped),
        failedCount: int(failed),
        notes: notes === null ? null : text(notes, 1000),
        finishedAt: finishedAt ?? nowIso(),
      })
      return repository.findRunById(runId)
    },

    findRunById(id) {
      const row = selectRunById.get(id)
      return row ? camelizeRow(row) : null
    },

    requireRunById(id) {
      return camelizeRow(requireRun(id))
    },

    latestRunForSource(sourceId) {
      const row = selectLatestRunForSource.get(sourceId)
      return row ? camelizeRow(row) : null
    },

    listRuns({ sourceId = null, status = null, limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      const params = {
        sourceId,
        status:
          status === null || status === undefined
            ? null
            : assertRunState(status),
        limit: page.limit,
        offset: page.offset,
      }
      const total = countRuns.get(params).total
      const items = camelizeRows(selectRuns.all(params)).map((row) => ({
        ...row,
        sourceKey: row.sourceKey ?? null,
        sourceName: row.sourceName ?? null,
        actorName: row.actorDisplayName ?? null,
      }))
      return { total, items }
    },

    /**
     * What the source has described before that this run did not.
     *
     * Report only, and deliberately so. A record missing from a freshly harvested
     * file is not evidence that the business has closed, only that the file did
     * not mention it: a source that paginates, or that was fetched on a bad day,
     * would otherwise be able to unpublish a real listing by omission. So this
     * returns candidates for a person to look at and changes nothing — no state,
     * no provenance, no deletion — which is what lets an operator trust the report
     * enough to act on it.
     */
    reconcileRun(runId) {
      const run = requireRun(runId)
      const stale = camelizeRows(
        selectStaleForRun.all({ sourceId: run.source_id, runId }),
      )
      const seen = selectRunSeenRefs.all({ runId })
      return {
        run: camelizeRow(run),
        source: repository.findSourceById(run.source_id),
        runRefCount: seen.length,
        stale,
        staleCount: stale.length,
      }
    },

    /* Review history --------------------------------------------------------- */

    eventsFor(businessId) {
      return camelizeRows(selectEventsByBusiness.all(businessId))
    },

    recentEvents({ limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      return camelizeRows(
        selectRecentEvents.all({ limit: page.limit, offset: page.offset }),
      )
    },

    eventCount() {
      return countEvents.get().total
    },

    /**
     * Everything about one record's history, in one call.
     *
     * The record page has to answer "where did this come from" and "what has
     * happened to it" without the reviewer clicking, and the two answers belong
     * together: a rejection with a reason next to the provenance that contradicts
     * it is how somebody catches their own mistake.
     */
    trail(businessId) {
      const events = repository.eventsFor(businessId)
      const provenance = repository.provenanceFor(businessId)
      const sourceId = provenance[0]?.sourceId ?? null
      return {
        provenance,
        events,
        source: sourceId ? repository.findSourceById(sourceId) : null,
      }
    },

    /* The queue -------------------------------------------------------------- */

    /**
     * The review queue, with the context needed to decide rather than only to sort.
     *
     * Oldest first within a state, because the oldest waiting record is the one most
     * likely to belong to a business somebody is waiting to be listed, and a queue
     * sorted newest-first makes exactly those the hardest to reach.
     */
    queue({
      state = QUEUE_STATE,
      sourceId = null,
      ownerId = null,
      unclaimed = false,
      limit,
      offset,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const params = {
        state: state ? assertReviewState(state) : null,
        sourceId,
        ownerId,
        unclaimed: unclaimed ? 1 : 0,
        limit: page.limit,
        offset: page.offset,
      }
      const total = countQueueRows.get(params).total
      const items = camelizeRows(selectQueueRows.all(params)).map((row) => ({
        ...row,
        ownerName: row.ownerDisplayName ?? null,
        sourceKey: row.sourceKey ?? null,
        sourceName: row.sourceName ?? null,
        // The legal actions travel with the row so a queue view cannot offer a
        // button the server will refuse, nor hide one it will accept. The rules
        // live in core/catalogue.js; this is a copy for rendering, and the server
        // checks again on write. Read `verificationState`, not the snake case: the
        // rows are already camelized above, and asking for the column name here
        // reads as undefined, which `assertReviewState` then rejects as an unknown
        // state instead of leaving the queue simply empty.
        availableActions: legalActions(row.verificationState),
        stateLabel: labelFor(row.verificationState),
      }))
      return { total, items }
    },

    /**
     * How much work is waiting at each step, zeroes included.
     *
     * `verified` is the step that publishes the directory, and it is the one that
     * silently does not happen: a queue of a thousand waiting and nothing verified
     * reads as a healthy pipeline until somebody notices the public count is not
     * moving. So the zeroes are reported too.
     */
    queueCounts() {
      const counts = { imported: 0, pending_review: 0, under_review: 0, verified: 0 }
      for (const row of countQueueByState.all()) counts[row.verification_state] = row.total
      return counts
    },

    /**
     * Records with no provenance at all.
     *
     * Should always be empty. It exists because "every catalogue record carries
     * provenance" is an invariant rather than a hope, and an invariant nobody
     * measures is an invariant that quietly stops holding.
     *
     * Paged properly, and ordered by `id` as well as `created_at`: a migration
     * that stamps every backfilled row with the same timestamp would otherwise
     * give the same first page forever, which looks exactly like a list that is
     * not advancing.
     */
    recordsWithoutProvenance({ limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      return camelizeRows(selectMissingProvenance.all(page))
    },

    countRecordsWithoutProvenance() {
      return countMissingProvenance.get().total
    },

    /* Intake ----------------------------------------------------------------- */

    /**
     * Brings one record in from a registered source, as one unit of work.
     *
     * This is the controlled path into the directory and the only one that may
     * claim a source. A record created here gets, in a single transaction, the
     * business row, its provenance, and an intake event naming the source that
     * produced it. Any of the three without the others is a state the platform
     * cannot explain later, so they are not separable.
     *
     * The state it lands in is `imported`, always. A source can assert that a
     * business exists; it cannot assert that this platform has checked it, and it
     * certainly cannot assert that the platform should publish it. A file claiming
     * `approved` in its verification column is recorded as a claim and ignored,
     * which is what `claimedState` in the result is for.
     *
     * `queue: true` submits it to the review queue in the same transaction, for a
     * source whose records are worth a reviewer's time on arrival. That is a
     * judgement about the source, not about the record, which is why it is the
     * caller that makes it.
     */
    intake({
      sourceKey,
      record,
      externalRef = null,
      batchRef = null,
      evidence = null,
      notes = null,
      actor = null,
      importedAt = null,
      runId = null,
      queue = false,
      claimedState = null,
    }) {
      const source = repository.requireSourceByKey(sourceKey)
      if (!source.isActive) {
        throw new ConflictError(
          `Catalogue source "${source.key}" is retired, so it cannot supply new records.`,
          { source: source.key },
        )
      }
      if (!record || typeof record !== 'object') {
        throw new ValidationError('An intake needs a record to ingest.', {
          field: 'record',
        })
      }

      const at = importedAt ?? nowIso()
      const write = db.transaction(() => {
        const business = businesses.create({
          ...record,
          // A record handed over by a source is a claim that the business exists,
          // not a draft somebody is still composing, so it lands `active` and the
          // review axis is left to do its job. `create` defaults to `draft` for
          // hand-authored listings, and a draft can never be published, so an
          // intake that inherited that default would make `approve` look like a
          // button that does nothing.
          status: record.status ?? 'active',
          // Not the source's claim, whatever the source says.
          verificationState: INTAKE_STATE,
          sourceId: record.sourceId ?? source.key,
          catalogueSourceId: source.id,
        })
        insertProvenance.run({
          id: newId(),
          businessId: business.id,
          sourceId: source.id,
          externalRef: text(externalRef, 200),
          batchRef: text(batchRef, 120),
          evidence: text(evidence, 500),
          notes: text(notes, 1000),
          importedAt: at,
          importedBy: actor?.id ?? null,
          runId,
        })
        insertIntakeEvent.run({
          id: newId(),
          businessId: business.id,
          toState: INTAKE_STATE,
          // `import` is the one action in the vocabulary that cannot be performed on
          // an existing record: there is no way back to intake, because intake is
          // how a record arrives rather than a place it can be moved to.
          action: 'import',
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          reason: text(notes, 500),
          sourceId: source.id,
          createdAt: at,
        })
        return queue ? repository.submit(business.id, { actor, at }) : business
      })

      const business = write()
      audit?.record({
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: 'catalogue.intake',
        entityType: 'business',
        entityId: business.id,
        reason: notes ?? null,
        after: { name: business.name, source: source.key, state: business.verificationState },
      })

      return {
        business,
        source,
        // What the source claimed, when it claimed something the platform refused to
        // honour. The import report shows this rather than silently dropping it, so
        // an operator is never misled about what happened to their file.
        claimedState: claimedState ?? null,
      }
    },

    /**
     * Moves a record on from intake into the review queue.
     *
     * Separate from `intake` because they are separate decisions. A record arrives
     * as `imported` — the platform knows it exists and nothing else — and entering
     * the queue says it is worth a person's time.
     */
    submit(businessId, { actor = null, reason = null, at = null } = {}) {
      const current = businesses.requireById(businessId)
      const plan = reviewPlan(current.verificationState, 'submit')
      if (!plan) {
        throw new ConflictError(
          `A record that is ${labelFor(current.verificationState)} cannot be submitted for review.`,
          {
            id: businessId,
            from: current.verificationState,
            allowedActions: legalActions(current.verificationState),
          },
        )
      }
      return businesses.review(businessId, { action: 'submit', actor, reason, at })
    },
  }

  return repository
}

function text(value, max) {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function int(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}
