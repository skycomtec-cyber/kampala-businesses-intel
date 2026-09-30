import {
  collection,
  single,
  toBoolean,
  toInteger,
  toPage,
  uuidPattern,
} from '../lib/http.js'
// `suppressIfBelowK` answers one question - may this aggregate leave? - and returns
// a decision, not the row's measurements: `{visible, suppressed, row, kThreshold}`.
// The measurements are read off the row itself below. Reading them off the verdict
// was the second half of the bug in migration 011: `verdict.distinctActors` was
// `undefined` on every row, so the published actor count was missing even once the
// underlying column existed.
import { suppressIfBelowK } from '../../core/privacy.js'
import { GAP_SEVERITIES, OPPORTUNITY_STATES } from '../../core/intelligence.js'

/**
 * Public opportunity insights.
 *
 * This is the part of the platform that most needs the privacy layer and is
 * therefore the part most worth reading twice.
 *
 * Every number here is an aggregate over searches from many people. Below the
 * k-anonymity floor it is not rounded, not capped and not approximated: it is
 * marked suppressed and the counts are withheld. The engine still knows the
 * answer, the caller is told it does not exist yet, and nobody can subtract their
 * own search away from a total of three to learn what the other two searched
 * for.
 *
 * The suppression flag is a first-class part of the response rather than a
 * header, because a chart that silently shows nothing is indistinguishable from a
 * chart that is broken, and the difference matters to a user deciding whether
 * Kampala's repair market looks thin.
 */

export default async function insightRoutes(fastify, { config, app }) {
  fastify.get(
    '/insights/opportunities',
    {
      schema: {
        summary: 'Ranked market opportunities, each subject to the k-anonymity floor.',
        tags: ['insights'],
        querystring: {
          type: 'object',
          properties: {
            locationId: { type: 'string', pattern: uuidPattern },
            // These two were the worst of the vocabulary drift, because they made the
            // endpoint look filterable while filtering nothing. The route asked for
            // `new`, `reviewing` and `actioned` on a column whose CHECK allows
            // `candidate`, `validating`, `actionable` and `acted_on`, and asked for
            // `medium` on a severity the engine writes as `moderate`. So
            // `?severity=moderate` was a 400 and `?severity=medium` always returned
            // nothing: the one value an operator would reach for was the one value
            // refused, and the value that was accepted could never occur.
            //
            // Both are now read from the engine rather than restated, so the two
            // cannot disagree again.
            state: { type: 'string', enum: [...OPPORTUNITY_STATES] },
            severity: { type: 'string', enum: [...GAP_SEVERITIES] },
            includeDismissed: { type: 'boolean' },
            includeSuppressed: { type: 'boolean' },
            sort: { type: 'string', enum: ['score', 'recent', 'demand', 'severity'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.intelligence.opportunities({
        locationId: request.query.locationId ?? null,
        state: request.query.state ?? null,
        severity: request.query.severity ?? null,
        includeDismissed: toBoolean(request.query.includeDismissed, 'includeDismissed') ?? false,
        sort: request.query.sort ?? 'score',
        ...page,
      })

      const kThreshold = config.privacy.kThreshold
      const items = result.items.map((row) => {
        const verdict = suppressIfBelowK(row, kThreshold)
        return {
          ...row,
          distinctActors: verdict.suppressed ? null : row.distinctActors,
          // `searches` is deliberately not mapped. There is no such column on
          // `opportunity`, and the nearest thing that does exist,
          // `estimatedMonthlySearches`, is a rounded projection rather than a count
          // of people behind it. Nulling a field that was always `undefined`
          // withheld nothing and implied a measurement the response never carried.
          suppressed: verdict.suppressed,
        }
      })

      // The page is filtered after the query, so the total has to be recounted
      // rather than reported, or `hasMore` would promise rows that are not there.
      const visible = toBoolean(request.query.includeSuppressed, 'includeSuppressed')
        ? items
        : items.filter((row) => !row.suppressed)

      return collection(visible, {
        total: visible.length,
        limit: page.limit,
        offset: page.offset,
      })
    },
  )

  /**
   * A single opportunity in full, including the numbers that were used to derive
   * it. `inputs` is stored rather than recomputed, so an opportunity stays
   * explainable after the data underneath it has moved on.
   */
  fastify.get(
    '/insights/opportunities/:id',
    {
      schema: {
        summary: 'One opportunity with the snapshot it was derived from.',
        tags: ['insights'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: uuidPattern } },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const opportunity = app.intelligence.opportunity(request.params.id)
      const verdict = suppressIfBelowK(opportunity, config.privacy.kThreshold)
      return single({
        ...opportunity,
        // As in the list route: the measurement comes off the row, not off the
        // decision, and there is no `searches` column to report.
        distinctActors: verdict.suppressed ? null : opportunity.distinctActors,
        suppressed: verdict.suppressed,
      })
    },
  )

  /**
   * What is being searched for, most-wanted first.
   *
   * The repository has already applied the floor, and returns the suppressed rows
   * flagged rather than dropped, because the lab needs to see that a signal exists
   * and is not yet publishable. The public view drops them.
   */
  fastify.get(
    '/insights/signals',
    {
      schema: {
        summary: 'Aggregated search demand, with any signal below the k-anonymity floor withheld.',
        tags: ['insights'],
        querystring: {
          type: 'object',
          required: ['from'],
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            locationId: { type: 'string', pattern: uuidPattern },
            includeSuppressed: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) => {
      const limit = toInteger(request.query.limit, 'limit', { min: 1, max: 100 }) ?? 50
      const signals = app.demand.topSignals({
        locationId: request.query.locationId ?? null,
        from: request.query.from,
        to: request.query.to ?? null,
        limit,
        kThreshold: config.privacy.kThreshold,
      })
      // A suppressed signal is listed so a reader can see that demand exists and
      // is not yet publishable, but its counts are withheld here. The repository
      // has to keep the exact numbers for the lab, which runs inside the
      // operator's own boundary; this is a public route, so the redaction has to
      // happen at this edge. `searchesBucket` survives because a bucketed label
      // ("1-9") says a signal is small without publishing the small number.
      const redacted = signals.map((signal) =>
        signal.suppressed
          ? { ...signal, searches: null, distinctActors: null }
          : signal,
      )

      const visible = toBoolean(request.query.includeSuppressed, 'includeSuppressed')
        ? redacted
        : redacted.filter((signal) => !signal.suppressed)
      return collection(visible, { total: visible.length, limit, offset: 0 })
    },
  )

  /**
   * A plain-language summary of the window. Cheap, cacheable, and the thing a
   * future Ask Kampala can quote without interpreting a table.
   */
  fastify.get(
    '/insights/summary',
    {
      schema: {
        summary: 'Demand totals and result-quality distribution for a window.',
        tags: ['insights'],
        querystring: {
          type: 'object',
          required: ['from'],
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('read'),
    },
    async (request) =>
      single(app.demand.summary({ since: request.query.from })),
  )
}
