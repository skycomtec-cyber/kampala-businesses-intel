import { ValidationError } from './errors.js'

/**
 * Gap and opportunity scoring.
 *
 * The gap engine is the reason the platform exists, so its scoring is a domain
 * rule with an explicit, auditable formula rather than something buried in a
 * SQL view. Every gap and opportunity row stores the inputs that produced it,
 * so any number shown in the lab can be explained and recomputed.
 *
 * Nothing here touches the database. The engine supplies the measurements; this
 * file supplies the reasoning.
 */

export const GAP_SEVERITIES = Object.freeze(['none', 'low', 'moderate', 'high', 'critical'])

/** Opportunity lifecycle. An opportunity is a hypothesis, not a promise. */
export const OPPORTUNITY_STATES = Object.freeze([
  'candidate',
  'validating',
  'actionable',
  'dismissed',
  'acted_on',
])

/**
 * Demand weight curve.
 *
 * A search that happened once is noise. A search that happened forty times in
 * a district in a month is a market. The curve is logarithmic precisely so
 * that a single viral post cannot manufacture a "critical" opportunity on its
 * own, and so the score keeps growing meaningfully as volume increases.
 *
 *   weight = ln(1 + searches) / ln(1 + 10)   clamped to [0, 1]
 */
export function demandWeight(searches) {
  const n = Math.max(0, Number(searches) || 0)
  if (n === 0) return 0
  return Math.min(1, Math.log1p(n) / Math.log1p(10))
}

/**
 * Supply adequacy.
 *
 * Full supply weight of 5.0 means there is demonstrably no unmet need. The
 * threshold is deliberately above 1.0: one unverified listing should never be
 * treated as covering a market, because concluding "supply is fine" from one
 * claim is how a directory talks itself out of reporting a real gap.
 */
export function supplyAdequacy(supplyScore) {
  const supply = Math.max(0, Number(supplyScore) || 0)
  return Math.min(1, supply / 5)
}

/**
 * The gap score itself: demand that is not met, weighted by how much the
 * people asking actually know what they want.
 *
 * A search that names a specific product and a specific place is a much
 * stronger claim about unmet need than a generic browse. Specificity is
 * therefore a multiplier, not an addend.
 */
export function computeGapScore({
  searches,
  supplyScore,
  distinctActors = 0,
  specificity = 0.5,
  kThreshold = 5,
  trendDelta = 0,
}) {
  // An aggregate that does not clear the privacy floor is not a gap, it is a
  // privacy hazard. It scores zero and is flagged as suppressed.
  if (distinctActors > 0 && distinctActors < kThreshold) {
    return { score: 0, severity: 'none', suppressed: true }
  }

  const demand = demandWeight(searches)
  const adequacy = supplyAdequacy(supplyScore)
  const unmet = Math.max(0, demand - adequacy)

  // Trend contribution is bounded so a spike can lift a score but never
  // manufacture one out of an otherwise negligible base.
  const trendBoost = Math.min(0.2, Math.max(-0.2, Number(trendDelta) || 0) * 0.2)

  const specificityMultiplier = 0.6 + clamp01(specificity) * 0.8
  const score = clamp01((unmet * specificityMultiplier + trendBoost) * 1.15)

  return {
    score: round4(score),
    severity: severityFor(score),
    suppressed: false,
  }
}

export function severityFor(score) {
  const value = clamp01(score)
  if (value >= 0.75) return 'critical'
  if (value >= 0.5) return 'high'
  if (value >= 0.25) return 'moderate'
  if (value > 0) return 'low'
  return 'none'
}

/**
 * Trend detection over a daily series.
 *
 * Compares the mean of the most recent `window` against the preceding `window`
 * and reports both the ratio and a plain-language direction. A ratio is only
 * reported when the baseline is large enough to be meaningful; otherwise a
 * change from 1 search to 2 searches would be reported as "100% growth", which
 * is exactly the kind of number that makes an opportunity dashboard untrustworthy.
 */
export function detectTrend(series, { window = 7, minBaseline = 3 } = {}) {
  const values = series.map((point) => Number(point) || 0)
  if (values.length < window * 2) {
    return { direction: 'insufficient_data', ratio: null, delta: 0, window }
  }

  const recent = values.slice(-window)
  const previous = values.slice(-window * 2, -window)
  const recentMean = mean(recent)
  const previousMean = mean(previous)
  const delta = round4(recentMean - previousMean)

  if (previousMean < minBaseline) {
    return {
      direction: recentMean > previousMean ? 'emerging' : 'insufficient_data',
      ratio: null,
      delta,
      window,
    }
  }

  const ratio = round4(recentMean / previousMean)
  let direction = 'flat'
  if (ratio >= 1.5) direction = 'rising'
  else if (ratio <= 0.66) direction = 'falling'
  else if (ratio >= 1.15) direction = 'edging_up'
  else if (ratio <= 0.85) direction = 'edging_down'

  return { direction, ratio, delta, window }
}

/**
 * Turns a confirmed gap into an opportunity with a stated rationale.
 *
 * The rationale is stored alongside the opportunity. A platform that tells a
 * business owner "there is an opportunity in Entebbe" without being able to say
 * why will be ignored the first time it is wrong, and rightly so.
 */
export function deriveOpportunity({ gap, trend, keyword, locationName }) {
  const drivers = []

  if (gap.severity === 'critical' || gap.severity === 'high') {
    drivers.push(
      `${gap.searches} recorded searches for "${keyword}" in ${locationName} with effectively no matching supply.`,
    )
  } else if (gap.severity === 'moderate') {
    drivers.push(
      `Unmet demand for "${keyword}" in ${locationName}: ${gap.searches} searches against ${gap.supplyCount} existing providers.`,
    )
  }

  if (trend.direction === 'rising') {
    drivers.push(
      `Demand is rising, up ${Math.round((trend.ratio - 1) * 100)}% over the previous ${trend.window} days.`,
    )
  } else if (trend.direction === 'emerging') {
    drivers.push('This is a new search pattern with no prior baseline to compare against.')
  }

  if (gap.averageResultQuality === 'none_in_area') {
    drivers.push('Supply exists, but not in the area being searched.')
  } else if (gap.averageResultQuality === 'single') {
    drivers.push('Only one provider serves this need, which is fragile coverage.')
  }

  const estimatedMonthlySearches = Math.round(gap.searches)

  return {
    keyword,
    locationName,
    severity: gap.severity,
    score: gap.score,
    estimatedMonthlySearches,
    trendDirection: trend.direction,
    rationale: drivers.join(' ') || 'Insufficient signal to state a rationale.',
    suggestedAction: suggestAction(gap, trend),
    state: 'candidate',
  }
}

function suggestAction(gap, trend) {
  if (gap.severity === 'critical' && gap.supplyCount === 0) {
    return 'No provider exists. Highest-value listing opportunity on the platform.'
  }
  if (gap.averageResultQuality === 'none_in_area' && gap.supplyCount > 0) {
    return 'Providers exist elsewhere. A local provider, or better location data, would close this gap.'
  }
  if (trend.direction === 'rising') {
    return 'Demand is growing. Prioritise verification and enrichment of existing supply here.'
  }
  if (gap.severity === 'moderate') {
    return 'Partial coverage. Focus on the specific sub-service the searches name.'
  }
  return 'Monitor. Signal is not yet strong enough to act on.'
}

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0))
const round4 = (value) => Math.round(value * 10000) / 10000
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
