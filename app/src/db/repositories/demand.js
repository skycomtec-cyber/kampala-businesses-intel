import crypto from 'node:crypto'
import { newId } from '../../core/identifiers.js'
import {
  isActionableQuery,
  demandTokens,
  demandPhrases,
  classifyResultQuality,
  assertInteractionType,
  RESULT_QUALITY_ORDER,
} from '../../core/demand.js'
import { pseudonymise, dailySalt, suppressIfBelowK, bucketCount } from '../../core/privacy.js'
import { COVERAGE_LEVELS } from '../../core/location.js'
import { camelizeRow, camelizeRows, camelizeJsonRow, nowIso, toJson, parseJson, toDayString } from '../mapping.js'

/**
 * The demand side of the data layer.
 *
 * Two responsibilities, kept in one repository because they are two halves of
 * the same write:
 *
 *   1. `recordSearch` turns a request into a demand signal, applying the privacy
 *      rules from core/privacy.js before anything is written.
 *   2. `rollupDemand` turns those events into the daily aggregate the gap engine
 *      reads. The split exists so that a slow rollup degrades the freshness of
 *      the lab without ever slowing down or losing a search.
 *
 * The raw query text is written to a separate table with its own expiry, and
 * every read of an aggregate goes through the k-anonymity floor. Those two rules
 * are the privacy contract of the whole platform.
 */

const QUALITY_RANK = Object.fromEntries(
  RESULT_QUALITY_ORDER.map((quality, index) => [quality, index]),
)

/** Surfaces whose searches are real market demand rather than internal traffic. */
const DEMAND_SURFACES = new Set(['web', 'api'])

export function createDemandRepository(db, config) {
  const insertSearchEvent = db.prepare(
    `INSERT INTO search_event (
       id, search_session_id, actor_bucket, day, surface, location_id, coverage_level,
       category_id, query_hash, tokens_json, phrases_json, n_tokens, n_phrases,
       specificity, total_results, in_area_results, result_quality, expires_at
     ) VALUES (
       @id, @searchSessionId, @actorBucket, @day, @surface, @locationId, @coverageLevel,
       @categoryId, @queryHash, @tokensJson, @phrasesJson, @nTokens, @nPhrases,
       @specificity, @totalResults, @inAreaResults, @resultQuality, @expiresAt
     )`,
  )
  const insertRawQuery = db.prepare(
    `INSERT INTO search_query_raw (
       id, search_event_id, salt, raw_query, normalised_query, expires_at
     ) VALUES (
       @id, @searchEventId, @salt, @rawQuery, @normalisedQuery, @expiresAt
     )`,
  )
  const insertInteraction = db.prepare(
    `INSERT INTO interaction_event (
       id, type, actor_bucket, day, search_event_id, business_id, location_id,
       result_rank, metadata_json, expires_at
     ) VALUES (
       @id, @type, @actorBucket, @day, @searchEventId, @businessId, @locationId,
       @resultRank, @metadataJson, @expiresAt
     )`,
  )
  const selectSearchEvent = db.prepare(`SELECT * FROM search_event WHERE id = ?`)
  const selectRawQuery = db.prepare(
    `SELECT raw_query, normalised_query FROM search_query_raw WHERE search_event_id = ?`,
  )
  const selectRecent = db.prepare(
    `SELECT id, day, surface, location_id, coverage_level, category_id, n_tokens,
            specificity, total_results, in_area_results, result_quality, created_at
       FROM search_event ORDER BY created_at DESC LIMIT ?`,
  )
  const selectSignal = db.prepare(
    `SELECT ${SIGNAL_COLUMNS} FROM demand_signal_daily
      WHERE phrase = ? AND location_id IS ?
        AND day >= ? AND day <= ?
      ORDER BY day ASC`,
  )
  const selectTopSignals = db.prepare(
    `SELECT ${SIGNAL_COLUMNS} FROM demand_signal_daily
      WHERE day >= ? AND (? IS NULL OR day <= ?) AND location_id IS ?
      ORDER BY searches DESC
      LIMIT ?`,
  )
  // The gap engine's demand side: one row per (phrase, location, ngram) across
  // the whole window rather than one per day.
  //
  // Searches and zero_results sum because they are counts of events. Coverage
  // does not sum: it is a qualitative label, and the most specific level present
  // in the window is the honest description of what people asked. `none_in_area`
  // sums because it is a count of sessions that found nothing nearby, but it is
  // capped at `searches` because a session can be recorded against a day it did
  // not roll up into, and an unachievable ratio is worse than a conservative one.
  //
  // `specificity` is averaged over sessions, so the average is weighted by how
  // many sessions each day contributed rather than being a flat mean of daily
  // means - one day with 200 sessions should move a 30-day mean far more than a
  // day with 2.
  //
  // coverage_level is aggregated as a rank rather than a string. COVERAGE_LEVELS
  // is a strict hierarchy, but the order in it means nothing to SQL: MAX() over
  // the raw text returns 'subcounty' over 'district' and 'region' over 'city',
  // which is alphabetical noise dressed up as specificity. Taking the highest
  // rank and naming it back in JS keeps the one ordering that actually means
  // something - the hierarchy in core/location.js - the single source of truth.
  const COVERAGE_RANK_CASE = COVERAGE_LEVELS.map(
    (level, index) => `WHEN '${level}' THEN ${index + 1}`,
  ).join('\n              ')
  const selectWindowSignals = db.prepare(
    `SELECT phrase,
            location_id,
            ngram_size,
            MAX(CASE coverage_level
              ${COVERAGE_RANK_CASE}
              ELSE 0 END) AS coverage_rank,
            SUM(searches) AS searches,
            SUM(zero_results) AS zero_results,
            MIN(none_in_area, SUM(searches)) AS none_in_area,
            SUM(distinct_actors) AS distinct_actors,
            CASE WHEN SUM(searches) > 0
                 THEN SUM(specificity_sum) / SUM(searches) ELSE 0 END AS specificity,
            AVG(total_results) AS average_results_per_day
       FROM demand_signal_daily
      WHERE day >= ? AND (? IS NULL OR day <= ?)
      GROUP BY phrase, location_id, ngram_size
      HAVING SUM(searches) > 0
      ORDER BY searches DESC, phrase ASC
      LIMIT ?`,
  )
  const deleteSignalDay = db.prepare(`DELETE FROM demand_signal_daily WHERE day = ?`)
  const deleteExpiredEvents = db.prepare(
    `DELETE FROM search_event WHERE expires_at IS NOT NULL AND expires_at <= ?`,
  )
  const deleteExpiredRaw = db.prepare(
    `DELETE FROM search_query_raw WHERE expires_at <= ?`,
  )
  const deleteExpiredInteractions = db.prepare(
    `DELETE FROM interaction_event WHERE expires_at IS NOT NULL AND expires_at <= ?`,
  )
  const countEvents = db.prepare(
    `SELECT COUNT(*) AS total FROM search_event WHERE day >= ?`,
  )
  const countZeroResults = db.prepare(
    `SELECT COUNT(*) AS total FROM search_event
      WHERE day >= ? AND result_quality IN ('zero', 'none_in_area')`,
  )
  const qualityDistribution = db.prepare(
    `SELECT result_quality, COUNT(*) AS total FROM search_event
      WHERE day >= ? GROUP BY result_quality`,
  )
  const searchableEvents = db.prepare(
    `SELECT location_id, coverage_level, tokens_json, phrases_json, actor_bucket,
            specificity, total_results, result_quality
       FROM search_event
      WHERE day = ? AND surface IN ('web', 'api') AND query_hash <> 'suppressed'`,
  )

  const retentionMs = () => config.privacy.rawSearchRetentionDays * 86400000
  const interactionRetentionMs = () => config.privacy.eventRetentionDays * 86400000

  /**
   * Derives the day-bucketed actor identity.
   *
   * The salt rotates daily, so the same person produces a different bucket
   * tomorrow. That is what makes the aggregate usable without being a profile:
   * the platform can count "how many people searched X in this district this
   * week" and is structurally unable to follow one person across days.
   */
  function actorBucket(actorSeed, at = new Date()) {
    const salt = dailySalt(config.auth.sessionSecret, at)
    return { salt, bucket: pseudonymise({ salt, actorSeed }) }
  }

  /**
   * Specificity: how precisely the person stated their need.
   *
   * A search that names both a service and a place is a far stronger claim about
   * unmet need than a generic browse, so specificity multiplies the gap score
   * rather than filtering anything out.
   */
  function computeSpecificity({ query, locationId, categoryId }) {
    const tokens = demandTokens(query)
    if (tokens.length === 0) return 0
    let score = Math.min(0.5, tokens.length * 0.15)
    if (locationId) score += 0.3
    if (categoryId) score += 0.2
    return Math.round(Math.min(1, score) * 1000) / 1000
  }

  const repository = {
    /**
     * Records a search as a demand signal.
     *
     * Returns null for navigational noise — "login", a pasted URL, a bare
     * UUID — because counting those would poison every trend the lab computes.
     * The caller still gets a search session; it just does not get a demand row.
     */
    recordSearch({
      query,
      surface = 'web',
      locationId = null,
      coverageLevel = null,
      categoryId = null,
      totalResults = 0,
      inAreaResults = null,
      searchSessionId = null,
      actorSeed = null,
      at = new Date(),
    }) {
      const raw = String(query ?? '').trim()
      if (!isActionableQuery(raw)) return null

      const tokens = demandTokens(raw)
      if (tokens.length === 0) return null
      const phrases = demandPhrases(raw)
      const quality = classifyResultQuality({ totalResults, inAreaResults })
      const { salt, bucket } = actorBucket(actorSeed ?? 'anonymous', at)
      const now = new Date(at)
      const expiresAt = new Date(now.getTime() + retentionMs()).toISOString()
      const id = newId()

      const write = db.transaction(() => {
        insertSearchEvent.run({
          id,
          searchSessionId,
          actorBucket: bucket,
          day: toDayString(now),
          surface,
          locationId,
          coverageLevel,
          categoryId,
          queryHash: crypto.createHash('sha256').update(raw.toLowerCase()).digest('hex'),
          tokensJson: toJson(tokens),
          phrasesJson: toJson(phrases),
          nTokens: tokens.length,
          nPhrases: phrases.length,
          specificity: computeSpecificity({ query: raw, locationId, categoryId }),
          totalResults,
          inAreaResults,
          resultQuality: quality,
          expiresAt,
        })
        insertRawQuery.run({
          id: newId(),
          searchEventId: id,
          salt,
          rawQuery: raw,
          normalisedQuery: tokens.join(' '),
          expiresAt,
        })
      })
      write()

      return {
        id,
        quality,
        tokens,
        phrases,
        specificity: computeSpecificity({ query: raw, locationId, categoryId }),
        day: toDayString(now),
      }
    },

    recordInteraction({
      type,
      actorSeed = null,
      searchEventId = null,
      businessId = null,
      locationId = null,
      resultRank = null,
      metadata = {},
      at = new Date(),
    }) {
      assertInteractionType(type)
      const write = db.transaction(() => {
        insertInteraction.run({
          id: newId(),
          type,
          actorBucket: actorSeed ? actorBucket(actorSeed, at).bucket : null,
          day: toDayString(at),
          searchEventId,
          businessId,
          locationId,
          resultRank,
          // Only the keys listed here are ever stored. An engineer adding a new
          // field has to add it here too, so a new field cannot leak by default.
          metadataJson: toJson(pickMetadata(metadata)),
          expiresAt: new Date(new Date(at).getTime() + interactionRetentionMs()).toISOString(),
        })
      })
      write()
      return true
    },

    searchEvent(id) {
      const row = selectSearchEvent.get(id)
      return row ? camelizeJsonRow(row, ['tokensJson', 'phrasesJson']) : null
    },

    /**
     * The raw text of a search, which only exists for the retention window and is
     * deliberately not reachable from any public route.
     */
    rawQuery(searchEventId) {
      return selectRawQuery.get(searchEventId) ?? null
    },

    recent(limit = 25) {
      return camelizeRows(selectRecent.all(limit))
    },

    /**
     * Aggregates one day of searches into demand_signal_daily.
     *
     * Unigrams and n-grams are rolled up separately, and a phrase is filed under
     * its first token as well: "laptop repair" contributes to the "laptop"
     * family so a term-level rollup and a phrase-level rollup can be compared
     * without a second pass.
     */
    rollupDay(day) {
      const rows = searchableEvents.all(day)
      const buckets = new Map()

      const accumulate = (locationId, coverageLevel, phrase, term, ngramSize, row) => {
        const key = `${locationId ?? ''}|${phrase}|${ngramSize}`
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = {
            locationId,
            coverageLevel,
            phrase,
            term,
            ngramSize,
            searches: 0,
            actors: new Set(),
            zeroResults: 0,
            noneInArea: 0,
            specificitySum: 0,
            totalResults: 0,
          }
          buckets.set(key, bucket)
        }
        bucket.searches += 1
        bucket.actors.add(row.actor_bucket)
        if (row.result_quality === 'zero') bucket.zeroResults += 1
        if (row.result_quality === 'none_in_area') bucket.noneInArea += 1
        bucket.specificitySum += row.specificity ?? 0
        bucket.totalResults += row.total_results ?? 0
      }

      for (const row of rows) {
        const tokens = parseJson(row.tokens_json, [])
        const phrases = parseJson(row.phrases_json, [])

        for (const token of tokens) {
          accumulate(row.location_id, row.coverage_level, token, token, 1, row)
        }
        for (const phrase of phrases) {
          // The head token is the family the phrase belongs to, so
          // "laptop repair" and "laptop screen replacement" are visible together.
          accumulate(
            row.location_id,
            row.coverage_level,
            phrase,
            phrase.split(' ')[0],
            phrase.split(' ').length,
            row,
          )
        }
      }

      const insert = db.prepare(
        `INSERT INTO demand_signal_daily (
           day, phrase, term, ngram_size, location_id, coverage_level, category_id,
           searches, distinct_actors, zero_results, none_in_area,
           specificity_sum, total_results
         ) VALUES (
           @day, @phrase, @term, @ngramSize, @locationId, @coverageLevel, NULL,
           @searches, @distinctActors, @zeroResults, @noneInArea,
           @specificitySum, @totalResults
         )`,
      )

      const apply = db.transaction(() => {
        // Delete-then-insert rather than an upsert: a re-run of the same day has
        // to also drop signals that no longer have events behind them, and an
        // upsert cannot remove rows it never visits.
        deleteSignalDay.run(day)
        for (const bucket of buckets.values()) {
          insert.run({
            day,
            phrase: bucket.phrase,
            term: bucket.term,
            ngramSize: bucket.ngramSize,
            locationId: bucket.locationId,
            coverageLevel: bucket.coverageLevel,
            searches: bucket.searches,
            distinctActors: bucket.actors.size,
            zeroResults: bucket.zeroResults,
            noneInArea: bucket.noneInArea,
            specificitySum: Math.round(bucket.specificitySum * 1000) / 1000,
            totalResults: bucket.totalResults,
          })
        }
      })
      apply()

      return { day, signals: buckets.size, events: rows.length }
    },

    rollupRange({ from, to }) {
      const results = []
      const start = new Date(`${from}T00:00:00.000Z`)
      const end = new Date(`${to}T00:00:00.000Z`)
      for (
        let cursor = new Date(start);
        cursor <= end;
        cursor = new Date(cursor.getTime() + 86400000)
      ) {
        results.push(this.rollupDay(toDayString(cursor)))
      }
      return results
    },

    /**
     * A daily series for one phrase at one location, ready for
     * core/intelligence.js detectTrend.
     */
    series({ phrase, locationId = null, from, to }) {
      return camelizeRows(selectSignal.all(phrase, locationId, from, to))
    },

    /**
     * The strongest demand in a place, with the privacy floor applied.
     *
     * `visible` false means the row exists but is refused. It is returned rather
     * than hidden so the lab can show "3 signals here, too few to publish", which
     * is more useful to an analyst than a silently empty list.
     */
    topSignals({ locationId = null, from, to = null, limit = 50, kThreshold }) {
      const rows = selectTopSignals.all(from, to, to, locationId, limit)
      return rows.map((row) => {
        const record = camelizeRow(row)
        const gate = suppressIfBelowK(
          { ...record, distinctActors: record.distinctActors },
          kThreshold ?? config.privacy.kThreshold,
        )
        return {
          ...record,
          visible: gate.visible,
          suppressed: gate.suppressed,
          kThreshold: gate.kThreshold,
          searchesBucket: bucketCount(record.searches),
        }
      })
    },

    /**
     * The demand half of a gap calculation: one row per phrase across a window.
     *
     * Where `topSignals` answers "what is the strongest demand today, for the
     * lab", this answers "what did people ask for over these 30 days", which is
     * the question a gap is about. A gap measured over a single day is noise;
     * one measured over a window is a market.
     *
     * The privacy gate is applied to the windowed actor count rather than to
     * each day. `distinct_actors` is summed across the window because a
     * day-bucketed actor is not a person and the same bucket can recur across
     * days, so the sum over-counts and never under-counts. Over-counting is the
     * safe direction: it can only ever fail to publish something borderline,
     * never publish something too small.
     */
    windowSignals({ from, to = null, limit = 200, kThreshold }) {
      const threshold = kThreshold ?? config.privacy.kThreshold
      return selectWindowSignals.all(from, to, to, limit).map((row) => {
        const { coverageRank, ...rest } = camelizeRow(row)
        const record = {
          ...rest,
          // The most specific level anyone actually searched at. Null when the
          // signal was recorded without a resolved location.
          coverageLevel: COVERAGE_LEVELS[coverageRank - 1] ?? null,
        }
        const gate = suppressIfBelowK(record, threshold)
        return {
          ...record,
          visible: gate.visible,
          suppressed: gate.suppressed,
          kThreshold: gate.kThreshold,
          // The share of sessions in the window that found nothing at all. A gap
          // is a demand that exists and is unmet, so this is what separates
          // "people want this and cannot find it" from "people did not want it
          // either".
          zeroResultRate:
            record.searches > 0
              ? Math.round((record.zeroResults / record.searches) * 1000) / 1000
              : 0,
          searchesBucket: bucketCount(record.searches),
        }
      })
    },

    /** Headline counters for the lab and the public stats page. */
    summary({ since }) {
      const distribution = Object.fromEntries(
        RESULT_QUALITY_ORDER.map((quality) => [quality, 0]),
      )
      for (const row of qualityDistribution.all(since)) {
        distribution[row.result_quality] = row.total
      }
      const events = countEvents.get(since).total
      const unservedShare =
        events === 0
          ? 0
          : Math.round(((distribution.zero + distribution.none_in_area) / events) * 1000) / 1000
      return {
        since,
        searches: events,
        unserved: countZeroResults.get(since).total,
        quality: distribution,
        unservedShare,
        // The ordering is exposed so a UI can render a stacked bar without
        // re-deriving which end of the scale is bad.
        qualityOrder: RESULT_QUALITY_ORDER,
        qualityRank: QUALITY_RANK,
      }
    },

    /**
     * Enforces the retention windows.
     *
     * The raw query table is purged first and independently: it is the only table
     * that can identify a person, so it gets its own job and its own audit trail
     * even though both tables share an expiry column.
     */
    purgeExpired() {
      const now = nowIso()
      const run = db.transaction(() => ({
        rawQueries: deleteExpiredRaw.run(now).changes,
        searchEvents: deleteExpiredEvents.run(now).changes,
        interactions: deleteExpiredInteractions.run(now).changes,
      }))
      return run()
    },
  }

  return repository
}

const SIGNAL_COLUMNS = `
  day, phrase, term, ngram_size, location_id, coverage_level,
  searches, distinct_actors, zero_results, none_in_area,
  specificity_sum, total_results
`

/** The only interaction metadata keys that are ever written. */
const ALLOWED_METADATA_KEYS = new Set([
  'resultCount',
  'filterCount',
  'clickTarget',
  'contactKind',
  'requestId',
  'offerId',
  'dwellBucket',
  'referrerKind',
])

function pickMetadata(metadata) {
  const result = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue
    result[key] = value
  }
  return result
}
