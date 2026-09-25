import { single } from '../lib/http.js'

/**
 * Liveness and self-description.
 *
 * These answer two different questions and live at two different paths for that
 * reason. `/healthz` sits outside the versioned prefix because a supervisor
 * should not have to know which API version is deployed to know whether the
 * process is alive. `/api/v1/meta` is versioned, because its shape is part of
 * the contract a client builds against.
 */

/** Liveness, for the launcher, a container orchestrator, or a human with curl. */
export async function healthRoutes(fastify, { app }) {
  fastify.get(
    '/healthz',
    {
      schema: {
        summary: 'Process liveness, database reachability and applied migration count.',
        tags: ['meta'],
      },
    },
    async () => {
      const health = app.health()
      return single({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        database: health.ok ? 'ready' : 'unavailable',
        migrationsApplied: health.migrations,
        ftsAvailable: health.fts,
      })
    },
  )
}

/**
 * What this engine is and what it currently holds.
 *
 * The privacy floor is published rather than hidden. A client that knows the
 * k-anonymity threshold can tell a user "not enough searches yet" instead of
 * rendering a broken chart, which is the difference between the intelligence
 * feeling broken and feeling young.
 */
export async function metaRoutes(fastify, { config, app }) {
  fastify.get(
    '/meta',
    {
      schema: {
        summary: 'Engine identity, reference data counts and the active privacy floor.',
        tags: ['meta'],
      },
    },
    async () =>
      single({
        name: 'Kampala Businesses Intelligence Platform',
        phase: 1,
        engine: 'kampala-data-engine',
        apiVersion: 'v1',
        environment: config.env,
        privacy: {
          kThreshold: config.privacy.kThreshold,
          rawSearchRetentionDays: config.privacy.rawSearchRetentionDays,
          eventRetentionDays: config.privacy.eventRetentionDays,
        },
        counts: {
          locations: app.locations.counts(),
          // The taxonomy is reference data rather than content, so a client can
          // tell "this engine has not been seeded" from "this engine is young".
          categories: app.categories.all().length,
          skills: app.skills.count(),
          activeBusinesses: app.businesses.countActive(),
          searchDocuments: app.searchIndex.count(),
        },
      }),
  )
}
