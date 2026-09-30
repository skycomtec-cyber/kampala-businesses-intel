import { classifyResultQuality } from '../core/demand.js'
import { computeGapScore, deriveOpportunity } from '../core/intelligence.js'

/**
 * The gap engine.
 *
 * This is the part of the platform that makes it worth running. Everything else
 * collects and displays; this is what compares what people ask for against what
 * the platform actually has, and turns the difference into a claim someone can
 * act on.
 *
 * It is a *runner*, not a scorer. All of the reasoning - how a gap is weighted,
 * when it is suppressed, what an opportunity is allowed to say - lives in
 * core/intelligence.js, where it can be recomputed from a stored snapshot and
 * must produce the same number. This file's only job is to measure, hand the
 * measurements to that reasoning, and record what came out.
 *
 * Until this existed, the tables it writes to were empty: demand was collected
 * and rolled up faithfully, the scoring rules were written and tested, and
 * nothing had ever called them together. An opportunity dashboard over an empty
 * table is not a quiet success, it is a feature that does not work.
 */

/** Severities at or above this become opportunities. Below it, they stay gaps. */
const SEVERITY_RANK = Object.freeze({
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
})

/**
 * One day's supply, nationwide and per level.
 *
 * Supply changes slowly and demand changes quickly, and the lab needs to be able
 * to tell "demand rose" from "supply fell" - the difference between an
 * opportunity and a warning. Recording supply as a daily series is what makes
 * that distinction possible at all.
 *
 * The gap rows measure supply *for a phrase*; this measures supply *in a place*,
 * which is the other half of the picture. A district can have plenty of supply
 * for what is listed there and still have a large gap, or the reverse.
 */

/**
 * A census of supply in a place, with no phrase involved.
 *
 * The other half of supply measurement from `supplyFor`: that one answers "how
 * much supply exists for what people are asking about", this answers "how much
 * supply exists here at all". The lab needs both - a district can be well stocked
 * overall and still have one large gap, and the gap number alone cannot tell
 * those apart from a district that is empty.
 *
 * Read from `search_document` rather than the business tables because that is
 * the same set of rows `supplyFor` measures, so the two numbers are
 * guaranteed to be talking about the same supply. `is_active` already
 * encodes public visibility per document, so no join to business is needed
 * for the counts.
 *
 * `locationId` scopes to a whole subtree: passing a district counts everything in
 * it and below. Passing nothing counts the country. That distinction is the
 * whole point of the scope column, so a row written for one place must never
 * carry another place's numbers.
 */

export function runGapEngine(repositories, options = {}) {
  const {
    config,
    demand,
    intelligence,
    locations,
    searchIndex,
  } = repositories

  const settings = config.intelligence
  const windowDays = options.windowDays ?? settings.windowDays
  const maxSignals = options.limit ?? settings.maxSignals
  const trendWindow = options.trendWindowDays ?? settings.trendWindowDays
  const floor = SEVERITY_RANK[options.opportunityFloor ?? settings.opportunityFloor] ?? 2

  const { from, to } = resolveWindow(windowDays, options.now)

  const run = intelligence.startRun({
    kind: 'gaps',
    windowDays,
    windowStart: from,
    windowEnd: to,
  })

  try {
    const signals = demand.windowSignals({ from, to, limit: maxSignals })
    const locationNames = locationNameCache(locations)

    const gaps = signals.map((signal) =>
      measureGap({
        signal,
        from,
        to,
        windowDays,
        trendWindow,
        intelligence,
        searchIndex,
        locationNames,
      }),
    )

    const stored = intelligence.writeGaps(run.id, gaps)

    // Opportunities are a view over the gaps just written, not a second opinion.
    // Deriving them from the stored rows rather than the in-memory ones means the
    // score, the supply count and the suppression flag on an opportunity are
    // provably the same values the gap snapshot holds.
    const opportunities = stored
      .filter((gap) => !gap.suppressed && (SEVERITY_RANK[gap.severity] ?? 0) >= floor)
      .map((gap) => {
        const trend = intelligence.trend({
          phrase: gap.phrase,
          locationId: gap.locationId,
          from,
          to,
          window: trendWindow,
        })
        return {
          gapSnapshotId: gap.id,
          keyword: gap.phrase,
          locationId: gap.locationId,
          locationName: gap.locationName,
          coverageLevel: null,
          categoryId: gap.categoryId,
          // The privacy floor is applied to this row again on the way out, by the
          // public route, so the count has to travel with it. Without it the route
          // reads nothing, treats the row as having zero actors, and withholds it.
          distinctActors: gap.distinctActors,
          ...deriveOpportunity({
            gap,
            trend,
            keyword: gap.phrase,
            locationName: gap.locationName,
          }),
        }
      })

    intelligence.recordOpportunities(opportunities)
    intelligence.recordSupplyMetrics(measureSupply(repositories, to, gaps))

    // The public counters. Written here rather than on read so that the stats page
    // is a snapshot of a specific run instead of a number that changes under the
    // reader's feet. The run's own timestamps carry the "when", so no timestamp is
    // forced into a counter column.
    const counts = intelligence.gapCountsForRun(run.id)
    intelligence.setStat('open_opportunities', opportunities.length)
    intelligence.setStat('gaps_total', stored.length)
    intelligence.setStat('gaps_critical', counts.critical ?? 0)
    intelligence.setStat('gaps_high', counts.high ?? 0)
    intelligence.setStat('gaps_moderate', counts.moderate ?? 0)
    intelligence.setStat('gaps_suppressed', stored.filter((gap) => gap.suppressed).length)

    return intelligence.completeRun(run.id, {
      searchesSeen: signals.reduce((sum, signal) => sum + signal.searches, 0),
      gapsWritten: stored.length,
      gapsSuppressed: stored.filter((gap) => gap.suppressed).length,
      opportunitiesWritten: opportunities.length,
      notes: summarise(stored, opportunities),
    })
  } catch (error) {
    // A run that failed is recorded as failed. Leaving it 'running' forever would
    // make the lab show a confident, stale picture rather than an error, which is
    // the more dangerous of the two.
    intelligence.failRun(run.id, error)
    throw error
  }
}

/**
 * Measures one (phrase, location) pair.
 *
 * The gap is demand minus supply, so both halves have to be measured the same
 * way: over the same window, in the same place, with the same privacy floor. If
 * demand is measured countrywide and supply is measured per district, the score
 * is a category error and will confidently report gaps that do not exist.
 */
function measureGap({
  signal,
  from,
  to,
  windowDays,
  trendWindow,
  intelligence,
  searchIndex,
  locationNames,
}) {
  // Supply is measured with the same place filter the demand was recorded under.
  // A null location is a genuine countrywide search, not a missing one, so it
  // measures the whole country and is stored with a countrywide label rather
  // than a blank.
  const supply = searchIndex.supplyFor({
    query: signal.phrase,
    locationId: signal.locationId,
  })

  const trend = intelligence.trend({
    phrase: signal.phrase,
    locationId: signal.locationId,
    from,
    to,
    window: trendWindow,
  })

  const scored = computeGapScore({
    searches: signal.searches,
    supplyScore: supply.supplyScore,
    distinctActors: signal.distinctActors,
    specificity: signal.specificity,
    kThreshold: signal.kThreshold,
    trendDelta: trend.delta,
  })

  return {
    phrase: signal.phrase,
    term: signal.term,
    ngramSize: signal.ngramSize,
    locationId: signal.locationId,
    coverageLevel: signal.coverageLevel,
    categoryId: null,
    skillId: null,
    locationName: locationNames(signal.locationId),
    windowDays,
    windowStart: from,
    windowEnd: to,
    searches: signal.searches,
    distinctActors: signal.distinctActors,
    supplyCount: supply.businessCount,
    supplyScore: supply.supplyScore,
    specificity: signal.specificity,
    // Classified the same way a live search is, from the same session totals, so
    // the label on a gap means exactly what the label on a search result means.
    averageResultQuality: classifyWindowQuality(signal),
    trendDirection: trend.direction,
    trendRatio: trend.ratio,
    trendDelta: trend.delta,
    gapScore: scored.score,
    severity: scored.severity,
    suppressed: scored.suppressed || signal.suppressed,
    kThreshold: signal.kThreshold,
    // The inputs, stored next to the score they produced, so any number in the lab
    // can be explained and recomputed rather than taken on trust.
    inputs: {
      supply: {
        businessCount: supply.businessCount,
        verifiedCount: supply.verifiedCount,
        documentCount: supply.documentCount,
        bySource: supply.bySource,
        supplyScore: supply.supplyScore,
      },
      demand: {
        searches: signal.searches,
        distinctActors: signal.distinctActors,
        zeroResults: signal.zeroResults,
        noneInArea: signal.noneInArea,
        zeroResultRate: signal.zeroResultRate,
        specificity: signal.specificity,
        ngramSize: signal.ngramSize,
      },
      trend,
    },
  }
}

/**
 * The result-quality label for a whole window.
 *
 * `classifyResultQuality` judges one search. A window is many searches, and the
 * distinction it draws between "nothing at all" and "something, just not near
 * here" is the single most useful thing a gap can say - so it is preserved rather
 * than averaged away.
 *
 * Averages cannot carry it: mean results per day blurs a signal that is
 * sometimes empty and sometimes rich into a middling number that means nothing.
 * The per-day `none_in_area` count is the direct measurement of it, so when the
 * window is dominated by sessions that found supply elsewhere, the label is
 * 'none_in_area' whatever the average says. Otherwise the average decides, and a
 * window that averaged zero results is 'zero'.
 */
function classifyWindowQuality(signal) {
  const searches = Math.max(0, signal.searches ?? 0)
  const noneInArea = Math.max(0, signal.noneInArea ?? 0)

  if (searches > 0 && noneInArea >= searches / 2) return 'none_in_area'
  return classifyResultQuality({
    totalResults: Math.round(signal.averageResultsPerDay ?? 0),
  })
}

/**
 * One supply census per scope this run actually compared against.
 *
 * The scopes come from the gaps just measured, not from a hardcoded list of
 * coverage levels. A hardcoded list reads like it measures each level and does
 * not: every row came back the national census, relabelled, so a reader asking
 * "how well supplied is Kampala" was served the whole country's number three
 * times under three different names. Deriving the scopes from the measured gaps
 * guarantees two things instead - every row is a place that was really looked
 * at, and the supply series lines up with the demand series it is compared
 * against, which is the only way "demand rose" can be told from "supply fell".
 *
 * The national total is kept as a baseline even when every gap was scoped to a
 * district, because a gap recorded with no resolved location is measured against
 * the whole country and needs a row to say so.
 *
 * Upserted rather than appended, so a second run on the same day refreshes the
 * day instead of doubling it.
 */
function measureSupply({ searchIndex }, day, gaps) {
  const scopes = new Map()
  for (const gap of gaps) {
    const key = `${gap.locationId ?? ''}|${gap.coverageLevel ?? ''}`
    if (!scopes.has(key)) {
      scopes.set(key, { locationId: gap.locationId, coverageLevel: gap.coverageLevel })
    }
  }
  // A gap recorded with no resolved location is measured against the whole
  // country, and it arrives here already claiming the national scope with no level
  // to name it. Adding the baseline on top of that would write the same census
  // twice under two labels, so the baseline is only added when the gaps did not
  // already supply one.
  const hasNational = [...scopes.values()].some((scope) => scope.locationId === null)
  if (!hasNational) scopes.set('|country', { locationId: null, coverageLevel: 'country' })

  return [...scopes.values()].map(({ locationId, coverageLevel }) => {
    const totals = searchIndex.supplyTotals({ locationId })
    return {
      day,
      locationId,
      coverageLevel,
      categoryId: null,
      skillId: null,
      businessCount: totals.businessCount,
      serviceCount: totals.serviceCount,
      productCount: totals.productCount,
      supplyScore: totals.supplyScore,
      verifiedCount: totals.verifiedCount,
    }
  })
}

/**
 * The window, as day strings.
 *
 * Today, not yesterday.
 *
 * This used to end the window on yesterday, on the reasoning that a day is only
 * complete once it has been rolled up and an unrolled day would drag the average
 * down and read as a fall in demand. The reasoning was sound and the conclusion
 * was not: `maintenance.js` rolls up *before* it measures, and it rolls up today,
 * so the day this excluded was a day the engine had already measured by proxy.
 *
 * The cost was that the newest data was structurally invisible, which on a young
 * platform is not a rounding error but the whole window. Both recorded runs on the
 * live database measured `searches_seen: 0` over a window that ended the day before
 * the only searches that existed. The engine had been collecting demand it could
 * not read since the first commit.
 *
 * The safety property the old window was protecting still holds, and it holds
 * elsewhere: a day that has not been rolled up contributes no demand rather than
 * being read as a day of silence, so running the engine without a fresh rollup
 * under-reports rather than mis-reports. `analyse.js` depends on that, because it
 * deliberately does not roll up.
 */
function resolveWindow(windowDays, now = new Date()) {
  const end = new Date(now)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (windowDays - 1))
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}

/**
 * Resolves location ids to names once per run.
 *
 * A gap reads its location name, and so does every opportunity derived from it.
 * Without the cache that is two lookups per phrase per run, and a run over a few
 * hundred phrases spends its time in a recursive location walk rather than in the
 * FTS queries the run exists to perform.
 */
function locationNameCache(locations) {
  const cache = new Map()
  return (locationId) => {
    if (!locationId) return 'Uganda'
    if (!cache.has(locationId)) {
      cache.set(locationId, locations.findById(locationId)?.name ?? locationId)
    }
    return cache.get(locationId)
  }
}

function summarise(stored, opportunities) {
  const bySeverity = stored.reduce((counts, gap) => {
    counts[gap.severity] = (counts[gap.severity] ?? 0) + 1
    return counts
  }, {})
  return `measured ${stored.length} signals, promoted ${opportunities.length}; ` +
    Object.entries(bySeverity)
      .map(([severity, count]) => `${severity}=${count}`)
      .join(' ')
}
