import {
  collection,
  paged,
  single,
  toBoolean,
  toInteger,
  toPage,
  uuidPattern,
  idParamSchema,
} from '../../lib/http.js'
import { GAP_SEVERITIES, OPPORTUNITY_STATES } from '../../../core/intelligence.js'

/**
 * Admin: the laboratory.
 *
 * This is the operator's own view of the intelligence engine, and it is the one
 * place in the platform that is allowed to see past the k-anonymity floor. The
 * public `/insights` routes exist to answer a stranger's question and are built
 * around `suppressIfBelowK`; the laboratory exists to answer the operator's, so
 * it asks the same repositories with `includeSuppressed` on and reports the rows
 * the public surface would have withheld. That asymmetry is the whole point: a
 * suppressed gap is still a finding, and somebody has to be able to see it to
 * know how much signal the promise is hiding.
 *
 * Nothing here computes anything. Scoring is `core/intelligence.js`, storage is
 * `db/repositories/intelligence.js`, and this file is the seam between them and
 * the operator's browser: validate, gate on a capability, hand the work down,
 * record the audit row.
 */

const GAP_SORTS = ['score', 'searches', 'newest', 'severity']
const OPPORTUNITY_SORTS = ['score', 'newest', 'demand', 'severity']
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

const overviewQuerySchema = {
  type: 'object',
  properties: { from: DATE },
  additionalProperties: false,
}

const gapsQuerySchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', pattern: uuidPattern },
    severity: { type: 'string', enum: [...GAP_SEVERITIES] },
    locationId: { type: 'string', pattern: uuidPattern },
    categoryId: { type: 'string', pattern: uuidPattern },
    minScore: { type: 'number', minimum: 0 },
    includeSuppressed: { type: 'boolean' },
    sort: { type: 'string', enum: GAP_SORTS },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const signalsQuerySchema = {
  type: 'object',
  required: ['from'],
  properties: {
    from: DATE,
    to: DATE,
    locationId: { type: 'string', pattern: uuidPattern },
    includeSuppressed: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
}

const supplyQuerySchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: DATE,
    to: DATE,
    locationId: { type: 'string', pattern: uuidPattern },
    categoryId: { type: 'string', pattern: uuidPattern },
  },
  additionalProperties: false,
}

const opportunitiesQuerySchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: [...OPPORTUNITY_STATES] },
    severity: { type: 'string', enum: [...GAP_SEVERITIES] },
    locationId: { type: 'string', pattern: uuidPattern },
    includeDismissed: { type: 'boolean' },
    includeSuppressed: { type: 'boolean' },
    sort: { type: 'string', enum: OPPORTUNITY_SORTS },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const stateBodySchema = {
  type: 'object',
  required: ['state'],
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: [...OPPORTUNITY_STATES] },
    // Optional in general, but the repository refuses a dismissal without one.
    // The requirement is enforced where the rule lives rather than duplicated
    // here, so the api and the data layer cannot disagree about what a legal
    // dismissal is.
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

/** A day `n` days before today, as `YYYY-MM-DD`, for a default report window. */
function dayOffset(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

export default async function adminLabRoutes(fastify, { config, app }) {
  /**
   * The dashboard's one-shot load.
   *
   * Everything the lab needs to render its first screen in a single request:
   * the latest engine run, the recent history, the gap counts the public never
   * sees, the opportunity board's shape, and a demand summary for the window.
   */
  fastify.get(
    '/admin/lab/overview',
    {
      schema: {
        summary: 'The laboratory dashboard: latest run, gap and opportunity counts, demand summary.',
        tags: ['admin'],
        querystring: overviewQuerySchema,
      },
      preHandler: fastify.requireCapability('lab:read'),
    },
    async (request) => {
      const run = app.intelligence.latestRun('gaps')
      const runId = run?.id ?? null
      // Asked twice on purpose: the visible total is what the public may see,
      // and the difference is what the privacy floor is holding back. That
      // difference is a number the operator should be able to watch.
      const visible = app.intelligence.gaps({ runId, includeSuppressed: false, limit: 1 })
      const all = app.intelligence.gaps({ runId, includeSuppressed: true, limit: 1 })
      const opportunities = Object.fromEntries(
        OPPORTUNITY_STATES.map((state) => [
          state,
          app.intelligence.opportunities({
            state,
            includeDismissed: true,
            includeSuppressed: true,
            limit: 1,
          }).total,
        ]),
      )
      return single({
        run,
        runs: app.intelligence.recentRuns(10),
        gaps: {
          visible: visible.total,
          suppressed: Math.max(0, all.total - visible.total),
          bySeverity: visible.bySeverity,
        },
        opportunities,
        demand: app.demand.summary({ since: request.query.from ?? dayOffset(30) }),
        stats: app.intelligence.stats(),
      })
    },
  )

  fastify.get(
    '/admin/lab/runs',
    {
      schema: {
        summary: 'Recent intelligence-engine runs.',
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
          additionalProperties: false,
        },
      },
      preHandler: fastify.requireCapability('lab:read'),
    },
    async (request) => {
      const limit = toInteger(request.query.limit, 'limit', { min: 1, max: 100 }) ?? 20
      const runs = app.intelligence.recentRuns(limit)
      return collection(runs, { total: runs.length, limit, offset: 0 })
    },
  )

  /**
   * The gaps as the engine recorded them, suppressed rows included.
   *
   * `includeSuppressed` defaults to true here, unlike the public route. An
   * operator opening the lab is asking "what did the engine find", and a
   * below-the-floor finding is part of the answer.
   */
  fastify.get(
    '/admin/lab/gaps',
    {
      schema: {
        summary: 'Gap snapshots with the k-anonymity floor lifted.',
        tags: ['admin'],
        querystring: gapsQuerySchema,
      },
      preHandler: fastify.requireCapability('lab:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.intelligence.gaps({
        runId: request.query.runId ?? null,
        severity: request.query.severity ?? null,
        locationId: request.query.locationId ?? null,
        categoryId: request.query.categoryId ?? null,
        minScore: toInteger(request.query.minScore, 'minScore', { min: 0 }),
        includeSuppressed:
          toBoolean(request.query.includeSuppressed, 'includeSuppressed') ?? true,
        sort: request.query.sort ?? 'score',
        ...page,
      })
      return paged(result, { ...page, bySeverity: result.bySeverity })
    },
  )

  /**
   * Demand signals with the real counts, which the public route redacts.
   *
   * `/insights/signals` nulls the counts of a suppressed signal and keeps the
   * bucketed label so a stranger learns a signal is small without learning how
   * small. The laboratory is inside the operator's boundary, so it gets the
   * counts.
   */
  fastify.get(
    '/admin/lab/signals',
    {
      schema: {
        summary: 'Aggregated search demand with suppressed counts visible.',
        tags: ['admin'],
        querystring: signalsQuerySchema,
      },
      preHandler: fastify.requireCapability('lab:read'),
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
      const includeSuppressed =
        toBoolean(request.query.includeSuppressed, 'includeSuppressed') ?? true
      const items = includeSuppressed ? signals : signals.filter((row) => !row.suppressed)
      return collection(items, { total: items.length, limit, offset: 0 })
    },
  )

  /** The daily supply census over a window, the other half of a gap. */
  fastify.get(
    '/admin/lab/supply',
    {
      schema: {
        summary: 'The daily supply series for a location and category over a window.',
        tags: ['admin'],
        querystring: supplyQuerySchema,
      },
      preHandler: fastify.requireCapability('lab:read'),
    },
    async (request) => {
      const series = app.intelligence.supplySeries({
        locationId: request.query.locationId ?? null,
        categoryId: request.query.categoryId ?? null,
        from: request.query.from,
        to: request.query.to,
      })
      return collection(series, { total: series.length, limit: series.length, offset: 0 })
    },
  )

  /**
   * The opportunity board, suppressed and dismissed rows included.
   *
   * The public list is the same query with the floor applied and dismissals
   * hidden; this one is the operator's working set, so nothing is filtered out
   * unless asked for.
   */
  fastify.get(
    '/admin/lab/opportunities',
    {
      schema: {
        summary: 'Opportunities with the k-anonymity floor lifted.',
        tags: ['admin'],
        querystring: opportunitiesQuerySchema,
      },
      preHandler: fastify.requireCapability('opportunity:read'),
    },
    async (request) => {
      const page = toPage(request.query)
      const result = app.intelligence.opportunities({
        state: request.query.state ?? null,
        severity: request.query.severity ?? null,
        locationId: request.query.locationId ?? null,
        includeDismissed:
          toBoolean(request.query.includeDismissed, 'includeDismissed') ?? true,
        includeSuppressed:
          toBoolean(request.query.includeSuppressed, 'includeSuppressed') ?? true,
        // No floor: the laboratory wants every row, not the publishable subset.
        kThreshold: null,
        sort: request.query.sort ?? 'score',
        ...page,
      })
      return paged(result, page)
    },
  )

  /**
   * Moves an opportunity through its lifecycle, and records who did it and why.
   *
   * The reason is optional for most transitions but required to dismiss, and
   * that rule lives in the repository so it applies to every caller. The audit
   * row is written here because the api is the layer that knows *who* acted; the
   * repository only ever sees an actor id.
   */
  fastify.patch(
    '/admin/lab/opportunities/:id',
    {
      schema: {
        summary: 'Change an opportunity state, recording the reason.',
        tags: ['admin'],
        params: idParamSchema,
        body: stateBodySchema,
      },
      preHandler: fastify.requireCapability('opportunity:write'),
    },
    async (request) => {
      const before = app.intelligence.opportunity(request.params.id)
      const updated = app.intelligence.setOpportunityState(
        request.params.id,
        request.body.state,
        { reason: request.body.reason ?? null, actorId: request.user.id },
      )
      app.audit.record({
        actorId: request.user.id,
        actorRole: request.user.role,
        action: 'intelligence.opportunity.state',
        entityType: 'opportunity',
        entityId: updated.id,
        reason: request.body.reason ?? null,
        before,
        after: updated,
      })
      return single(updated)
    },
  )
}
