import { newId } from '../../core/identifiers.js'
import { detectTrend, GAP_SEVERITIES, OPPORTUNITY_STATES } from '../../core/intelligence.js'
import { assertCoverageLevel, COVERAGE_LEVELS } from '../../core/location.js'
import { NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso, toSqlBool, fromSqlBool, parseJson, toJson } from '../mapping.js'
import { normalisePagination, where, resolveOrder } from './common.js'

/**
 * The intelligence side of the data layer.
 *
 * This repository stores computed findings; it does not compute them. Scoring
 * lives in core/intelligence.js so that a gap can be recomputed from its own row
 * and must produce the same number. What lives here is the bookkeeping around
 * that: runs that record what was measured, snapshots that store the inputs next
 * to the outputs, and opportunities that carry a stated rationale.
 *
 * The suppression flag is written with the row, not applied at read time. A gap
 * below the k-anonymity floor is stored with a zero score, so it travels into any
 * export, report or future retrieval path already defused.
 */

const GAP_COLUMNS = `
  id, run_id, computed_at, phrase, term, ngram_size, location_id, coverage_level,
  category_id, skill_id, location_name, window_days, window_start, window_end,
  searches, distinct_actors, supply_count, supply_score, specificity,
  average_result_quality, trend_direction, trend_ratio, trend_delta, gap_score,
  severity, suppressed, k_threshold, inputs_json
`

const GAP_SORTS = Object.freeze({
  score: 'gap_score DESC',
  searches: 'searches DESC',
  newest: 'computed_at DESC',
  severity: `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                              WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC`,
})

const OPPORTUNITY_SORTS = Object.freeze({
  score: 'score DESC',
  newest: 'created_at DESC',
  severity: `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                              WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC`,
})

export function createIntelligenceRepository(db, config) {
  const insertRun = db.prepare(
    `INSERT INTO intelligence_run (
       id, kind, status, window_days, window_start, window_end, k_threshold, started_at
     ) VALUES (
       @id, @kind, 'running', @windowDays, @windowStart, @windowEnd, @kThreshold, @startedAt
     )`,
  )
  const selectRun = db.prepare(`SELECT * FROM intelligence_run WHERE id = ?`)
  const selectLatestRun = db.prepare(
    `SELECT * FROM intelligence_run WHERE kind = ? AND status = 'completed'
      ORDER BY finished_at DESC LIMIT 1`,
  )
  const selectRecentRuns = db.prepare(
    `SELECT * FROM intelligence_run ORDER BY started_at DESC LIMIT ?`,
  )
  const finishRun = db.prepare(
    `UPDATE intelligence_run
        SET status = 'completed',
            searches_seen = @searchesSeen,
            gaps_written = @gapsWritten,
            gaps_suppressed = @gapsSuppressed,
            opportunities_written = @opportunitiesWritten,
            opportunities_advanced = @opportunitiesAdvanced,
            notes = @notes,
            finished_at = @now
      WHERE id = @id`,
  )
  const failRun = db.prepare(
    `UPDATE intelligence_run
        SET status = 'failed', error = @error, finished_at = @now
      WHERE id = @id`,
  )

  const insertGap = db.prepare(
    `INSERT INTO gap_snapshot (
       id, run_id, phrase, term, ngram_size, location_id, coverage_level, category_id,
       skill_id, location_name, window_days, window_start, window_end, searches,
       distinct_actors, supply_count, supply_score, specificity,
       average_result_quality, trend_direction, trend_ratio, trend_delta, gap_score,
       severity, suppressed, k_threshold, inputs_json
     ) VALUES (
       @id, @runId, @phrase, @term, @ngramSize, @locationId, @coverageLevel, @categoryId,
       @skillId, @locationName, @windowDays, @windowStart, @windowEnd, @searches,
       @distinctActors, @supplyCount, @supplyScore, @specificity,
       @averageResultQuality, @trendDirection, @trendRatio, @trendDelta, @gapScore,
       @severity, @suppressed, @kThreshold, @inputsJson
     )`,
  )
  const selectGaps = db.prepare(`SELECT ${GAP_COLUMNS} FROM gap_snapshot g`)
  const selectGap = db.prepare(`SELECT ${GAP_COLUMNS} FROM gap_snapshot g WHERE id = ?`)
  const latestGapByPhrase = db.prepare(
    `SELECT ${GAP_COLUMNS} FROM gap_snapshot g
      WHERE phrase = ? AND location_id IS ?
      ORDER BY computed_at DESC LIMIT 1`,
  )
  const countGaps = db.prepare(
    `SELECT severity, COUNT(*) AS total FROM gap_snapshot
      WHERE run_id = ? AND suppressed = 0 GROUP BY severity`,
  )

  const upsertSupplyMetric = db.prepare(
    `INSERT INTO supply_metric_daily (
       day, location_id, coverage_level, category_id, skill_id,
       business_count, service_count, product_count, supply_score, verified_count
     ) VALUES (
       @day, @locationId, @coverageLevel, @categoryId, @skillId,
       @businessCount, @serviceCount, @productCount, @supplyScore, @verifiedCount
     )
     ON CONFLICT(day, location_id, category_id, skill_id) DO UPDATE SET
       business_count = excluded.business_count,
       service_count = excluded.service_count,
       product_count = excluded.product_count,
       supply_score = excluded.supply_score,
       verified_count = excluded.verified_count,
       updated_at = excluded.updated_at`,
  )
  const selectSupplyMetric = db.prepare(
    `SELECT * FROM supply_metric_daily
      WHERE location_id IS ? AND category_id IS ? AND day >= ? AND day <= ?
      ORDER BY day ASC`,
  )

  const upsertOpportunity = db.prepare(
    `INSERT INTO opportunity (
       id, gap_snapshot_id, keyword, location_id, location_name, coverage_level,
       category_id, severity, score, estimated_monthly_searches, supply_count,
       trend_direction, rationale, suggested_action, state, created_at, updated_at
     ) VALUES (
       @id, @gapSnapshotId, @keyword, @locationId, @locationName, @coverageLevel,
       @categoryId, @severity, @score, @estimatedMonthlySearches, @supplyCount,
       @trendDirection, @rationale, @suggestedAction, @state, @now, @now
     )
     ON CONFLICT(keyword, location_id) DO UPDATE SET
       gap_snapshot_id = excluded.gap_snapshot_id,
       location_name = excluded.location_name,
       coverage_level = excluded.coverage_level,
       category_id = excluded.category_id,
       severity = excluded.severity,
       score = excluded.score,
       estimated_monthly_searches = excluded.estimated_monthly_searches,
       supply_count = excluded.supply_count,
       trend_direction = excluded.trend_direction,
       rationale = excluded.rationale,
       suggested_action = excluded.suggested_action,
       updated_at = excluded.updated_at`,
  )
  const selectOpportunity = db.prepare(`SELECT * FROM opportunity WHERE id = ?`)
  const selectOpportunities = db.prepare(`SELECT * FROM opportunity o`)
  const setOpportunityState = db.prepare(
    `UPDATE opportunity
        SET state = @state, state_reason = @reason, state_changed_at = @now,
            state_changed_by = @actorId,
            acted_on_at = CASE WHEN @state = 'acted_on' THEN @now ELSE acted_on_at END,
            updated_at = @now
      WHERE id = @id`,
  )

  const upsertStat = db.prepare(
    `INSERT INTO platform_stat (key, value, computed_at)
     VALUES (@key, @value, @now)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at`,
  )
  const selectStat = db.prepare(`SELECT value, computed_at FROM platform_stat WHERE key = ?`)

  function gapRow(row) {
    const record = camelizeRow(row)
    record.inputs = parseJson(record.inputsJson, {})
    delete record.inputsJson
    record.suppressed = fromSqlBool(record.suppressed)
    return record
  }

  function opportunityRow(row) {
    return camelizeRow(row)
  }

  const repository = {
    // ---- Runs ---------------------------------------------------------------

    startRun({ kind = 'gaps', windowDays = 30, windowStart = null, windowEnd = null } = {}) {
      const id = newId()
      insertRun.run({
        id,
        kind,
        windowDays,
        windowStart,
        windowEnd,
        kThreshold: config.privacy.kThreshold,
        startedAt: nowIso(),
      })
      return camelizeRow(selectRun.get(id))
    },

    completeRun(id, {
      searchesSeen = 0,
      gapsWritten = 0,
      gapsSuppressed = 0,
      opportunitiesWritten = 0,
      opportunitiesAdvanced = 0,
      notes = null,
    } = {}) {
      finishRun.run({
        id,
        searchesSeen,
        gapsWritten,
        gapsSuppressed,
        opportunitiesWritten,
        opportunitiesAdvanced,
        notes,
        now: nowIso(),
      })
      return camelizeRow(selectRun.get(id))
    },

    /**
     * A failed run is recorded, not swallowed.
     *
     * A gap engine that fails silently leaves the lab showing a confident, stale,
     * empty picture, which is worse than showing an error.
     */
    failRun(id, error) {
      failRun.run({
        id,
        error: String(error?.message ?? error).slice(0, 2000),
        now: nowIso(),
      })
      return camelizeRow(selectRun.get(id))
    },

    latestRun(kind = 'gaps') {
      const row = selectLatestRun.get(kind)
      return row ? camelizeRow(row) : null
    },

    recentRuns(limit = 20) {
      return camelizeRows(selectRecentRuns.all(limit))
    },

    run(id) {
      const row = selectRun.get(id)
      return row ? camelizeRow(row) : null
    },

    // ---- Supply metrics -----------------------------------------------------

    /**
     * Stores one day's supply measurement.
     *
     * Supply changes slowly and demand changes quickly. Keeping supply as an
     * explicit daily series is what lets the lab distinguish "demand rose" from
     * "supply fell", which is the difference between an opportunity and a warning.
     */
    recordSupplyMetric(metric) {
      assertCoverageLevel(metric.coverageLevel ?? 'country')
      upsertSupplyMetric.run({
        day: metric.day,
        locationId: metric.locationId ?? null,
        coverageLevel: metric.coverageLevel ?? null,
        categoryId: metric.categoryId ?? null,
        skillId: metric.skillId ?? null,
        businessCount: metric.businessCount ?? 0,
        serviceCount: metric.serviceCount ?? 0,
        productCount: metric.productCount ?? 0,
        supplyScore: metric.supplyScore ?? 0,
        verifiedCount: metric.verifiedCount ?? 0,
        updatedAt: nowIso(),
      })
      return true
    },

    recordSupplyMetrics(metrics) {
      const write = db.transaction((list) => {
        for (const metric of list) this.recordSupplyMetric(metric)
      })
      write(metrics)
      return metrics.length
    },

    supplySeries({ locationId = null, categoryId = null, from, to }) {
      return camelizeRows(selectSupplyMetric.all(locationId, categoryId, from, to))
    },

    /**
     * The daily demand series for one phrase at one location, with zero-filled
     * days.
     *
     * Zero filling matters: a gap in the data and a day with no searches both
     * mean "nothing happened", and detectTrend's ratio is meaningless if a
     * missing day is silently treated as a low count.
     */
    demandSeries({ phrase, locationId = null, from, to }) {
      const rows = db
        .prepare(
          `SELECT day, searches FROM demand_signal_daily
            WHERE phrase = ? AND location_id IS ? AND day >= ? AND day <= ?
            ORDER BY day ASC`,
        )
        .all(phrase, locationId, from, to)
      const byDay = new Map(rows.map((row) => [row.day, row.searches]))
      const series = []
      for (
        let cursor = new Date(`${from}T00:00:00.000Z`);
        cursor <= new Date(`${to}T00:00:00.000Z`);
        cursor = new Date(cursor.getTime() + 86400000)
      ) {
        const day = cursor.toISOString().slice(0, 10)
        series.push({ day, searches: byDay.get(day) ?? 0 })
      }
      return series
    },

    trend({ phrase, locationId = null, from, to, window = 7, minBaseline = 3 }) {
      return detectTrend(this.demandSeries({ phrase, locationId, from, to }), {
        window,
        minBaseline,
      })
    },

    // ---- Gaps ---------------------------------------------------------------

    /**
     * Writes a batch of gaps for one run.
     *
     * `suppressed` is honoured from the caller rather than recomputed here,
     * because the decision belongs to core/intelligence.js and is already made by
     * the time a gap reaches the data layer. A suppressed gap is still stored —
     * with a zero score — so that the lab can count how much signal the privacy
     * floor is hiding, which is itself a finding.
     */
    writeGaps(runId, gaps) {
      const write = db.transaction((list) => {
        for (const gap of list) {
          insertGap.run({
            id: newId(),
            runId,
            phrase: gap.phrase,
            term: gap.term ?? gap.phrase.split(' ')[0],
            ngramSize: gap.ngramSize ?? gap.phrase.split(' ').length,
            locationId: gap.locationId ?? null,
            coverageLevel: gap.coverageLevel ?? null,
            categoryId: gap.categoryId ?? null,
            skillId: gap.skillId ?? null,
            locationName: gap.locationName ?? null,
            windowDays: gap.windowDays ?? 30,
            windowStart: gap.windowStart ?? null,
            windowEnd: gap.windowEnd ?? null,
            searches: gap.searches ?? 0,
            distinctActors: gap.distinctActors ?? 0,
            supplyCount: gap.supplyCount ?? 0,
            supplyScore: gap.supplyScore ?? 0,
            specificity: gap.specificity ?? 0,
            averageResultQuality: gap.averageResultQuality ?? 'zero',
            trendDirection: gap.trendDirection ?? 'insufficient_data',
            trendRatio: gap.trendRatio ?? null,
            trendDelta: gap.trendDelta ?? 0,
            gapScore: gap.suppressed ? 0 : (gap.gapScore ?? 0),
            severity: gap.suppressed ? 'none' : (gap.severity ?? 'none'),
            suppressed: toSqlBool(Boolean(gap.suppressed)),
            kThreshold: gap.kThreshold ?? config.privacy.kThreshold,
            inputsJson: toJson(gap.inputs ?? {}),
          })
        }
      })
      write(gaps)
      return gaps.length
    },

    gaps({
      runId = null,
      severity = null,
      locationId,
      categoryId,
      minScore = null,
      includeSuppressed = false,
      sort = 'score',
      limit,
      offset,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}

      if (runId) {
        conditions.push('g.run_id = @runId')
        params.runId = runId
      }
      if (severity) {
        if (!GAP_SEVERITIES.includes(severity)) {
          throw new ValidationError(`Unknown severity "${severity}".`, {
            allowed: GAP_SEVERITIES,
          })
        }
        conditions.push('g.severity = @severity')
        params.severity = severity
      }
      if (locationId) {
        conditions.push('g.location_id = @locationId')
        params.locationId = locationId
      }
      if (categoryId) {
        conditions.push('g.category_id = @categoryId')
        params.categoryId = categoryId
      }
      if (minScore !== null) {
        conditions.push('g.gap_score >= @minScore')
        params.minScore = minScore
      }
      if (!includeSuppressed) conditions.push('g.suppressed = 0')

      const whereSql = where(conditions)
      const order = resolveOrder(sort, GAP_SORTS, GAP_SORTS.score)
      const rows = db
        .prepare(
          `SELECT ${GAP_COLUMNS} FROM gap_snapshot g
            ${whereSql}
            ORDER BY ${order}, g.id ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const totals = db
        .prepare(
          `SELECT severity, COUNT(*) AS total FROM gap_snapshot g ${whereSql} GROUP BY severity`,
        )
        .all(params)

      const total = totals.reduce((sum, row) => sum + row.total, 0)
      return {
        total,
        bySeverity: Object.fromEntries(totals.map((row) => [row.severity, row.total])),
        items: rows.map(gapRow),
      }
    },

    gap(id) {
      const row = selectGap.get(id)
      return row ? gapRow(row) : null
    },

    latestGap(phrase, locationId = null) {
      const row = latestGapByPhrase.get(phrase, locationId)
      return row ? gapRow(row) : null
    },

    gapCountsForRun(runId) {
      return Object.fromEntries(
        countGaps.all(runId).map((row) => [row.severity, row.total]),
      )
    },

    // ---- Opportunities ------------------------------------------------------

    /**
     * Upserts opportunities by (keyword, location).
     *
     * Re-running the engine refreshes an existing opportunity rather than
     * creating a duplicate. The alternative is an opportunity list that fills
     * with the same finding every time anyone recomputes, which is exactly how
     * people learn to ignore the list.
     */
    recordOpportunities(entries) {
      const write = db.transaction((list) => {
        for (const entry of list) {
          upsertOpportunity.run({
            id: newId(),
            gapSnapshotId: entry.gapSnapshotId ?? null,
            keyword: entry.keyword,
            locationId: entry.locationId ?? null,
            locationName: entry.locationName ?? null,
            coverageLevel: entry.coverageLevel ?? null,
            categoryId: entry.categoryId ?? null,
            severity: entry.severity ?? 'none',
            score: entry.score ?? 0,
            estimatedMonthlySearches: entry.estimatedMonthlySearches ?? 0,
            supplyCount: entry.supplyCount ?? 0,
            trendDirection: entry.trendDirection ?? 'insufficient_data',
            rationale: entry.rationale ?? '',
            suggestedAction: entry.suggestedAction ?? null,
            state: 'candidate',
            now: nowIso(),
          })
        }
      })
      write(entries)
      return entries.length
    },

    opportunity(id) {
      const row = selectOpportunity.get(id)
      if (!row) throw new NotFoundError('Opportunity', id)
      return opportunityRow(row)
    },

    opportunities({
      state,
      severity,
      locationId,
      includeDismissed = false,
      sort = 'score',
      limit,
      offset,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}

      if (state) {
        if (!OPPORTUNITY_STATES.includes(state)) {
          throw new ValidationError(`Unknown opportunity state "${state}".`, {
            allowed: OPPORTUNITY_STATES,
          })
        }
        conditions.push('o.state = @state')
        params.state = state
      }
      if (severity) {
        conditions.push('o.severity = @severity')
        params.severity = severity
      }
      if (locationId) {
        conditions.push('o.location_id = @locationId')
        params.locationId = locationId
      }
      if (!includeDismissed) {
        conditions.push(`o.state <> 'dismissed'`)
      }

      const whereSql = where(conditions)
      const order = resolveOrder(sort, OPPORTUNITY_SORTS, OPPORTUNITY_SORTS.score)
      const rows = db
        .prepare(
          `SELECT * FROM opportunity o ${whereSql}
            ORDER BY ${order}, o.id ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM opportunity o ${whereSql}`)
        .get(params).total

      return { total, items: rows.map(opportunityRow) }
    },

    /**
     * Moves an opportunity through its lifecycle, and requires a reason when it
     * is dismissed. An opportunity dismissed without an explanation is a finding
     * the engine can never learn to stop producing.
     */
    setOpportunityState(id, state, { reason = null, actorId = null } = {}) {
      if (!OPPORTUNITY_STATES.includes(state)) {
        throw new ValidationError(`Unknown opportunity state "${state}".`, {
          allowed: OPPORTUNITY_STATES,
        })
      }
      if (state === 'dismissed' && !reason) {
        throw new ValidationError('Dismissing an opportunity requires a reason.', {
          field: 'reason',
        })
      }
      if (!selectOpportunity.get(id)) throw new NotFoundError('Opportunity', id)
      setOpportunityState.run({ id, state, reason, actorId, now: nowIso() })
      return repository.opportunity(id)
    },

    // ---- Public counters ----------------------------------------------------

    setStat(key, value) {
      upsertStat.run({ key, value: Math.trunc(Number(value) || 0), now: nowIso() })
      return true
    },

    stat(key, fallback = 0) {
      const row = selectStat.get(key)
      return row ? row.value : fallback
    },

    stats() {
      return Object.fromEntries(
        db
          .prepare(`SELECT key, value, computed_at FROM platform_stat ORDER BY key`)
          .all()
          .map((row) => [row.key, { value: row.value, computedAt: row.computed_at }]),
      )
    },

    coverageLevels: COVERAGE_LEVELS,
  }

  return repository
}
