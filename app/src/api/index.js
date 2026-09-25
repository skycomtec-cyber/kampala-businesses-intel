import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'

import errorPlugin from './plugins/errors.js'
import securityPlugin from './plugins/security.js'
import rateLimitPlugin from './plugins/rateLimit.js'
import sessionPlugin from './plugins/session.js'
import { healthRoutes, metaRoutes } from './routes/health.js'
import authRoutes from './routes/auth.js'
import businessRoutes from './routes/businesses.js'
import referenceRoutes from './routes/reference.js'
import marketplaceRoutes from './routes/marketplace.js'
import insightRoutes from './routes/insights.js'
import adminBusinessRoutes from './routes/admin/businesses.js'
import adminImportRoutes from './routes/admin/imports.js'

/**
 * The api layer's assembly.
 *
 * This is the only file that knows which route modules exist and in what order
 * they are mounted. Everything below it is a plugin: it receives a fastify
 * instance plus options, and never reaches for a global.
 *
 * Two things about the order here are load-bearing:
 *
 *   1. The plugins are registered before any route, because a route declares
 *      `preHandler: fastify.enforceRateLimit('read')` at definition time. That
 *      is a method call while the route is being defined, so the decorator has to
 *      exist first or registration throws.
 *   2. The versioned routes go in their own encapsulated scope behind a prefix,
 *      so the whole contract can be mounted a second time under /api/v2 later
 *      without editing a route module.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WEB_ROOT = path.resolve(HERE, '..', '..', 'web')

/**
 * Builds an unstarted fastify instance with everything mounted.
 *
 * Returns the instance rather than starting it, because the test suite mounts the
 * same function with `inject()` and never binds a port.
 *
 * @param {object} options
 * @param {object} options.app the open database handle and repositories
 * @param {object} options.config resolved application config
 * @param {boolean} [options.logger] structured request logging (default true)
 * @param {boolean} [options.web] serve app/web when the folder exists (default true)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApi({ app, config, logger = true, web = true }) {
  const fastify = Fastify({
    logger:
      logger === false
        ? false
        : {
            level: process.env.KIP_LOG_LEVEL ?? (config.env === 'test' ? 'silent' : 'info'),
          },
    // Reject an oversized body before it is parsed. A business profile with a few
    // hundred characters of text is the largest legitimate request here.
    bodyLimit: config.api.bodyLimit,
    // Only trust X-Forwarded-For when a proxy in front of us sets it, otherwise a
    // client could spoof its own address and walk straight past the rate limiter.
    trustProxy: config.api.trustProxy,
    routerOptions: {
      // `/search` and `/search/` are the same request, and a hand-typed url in a
      // browser should not be answered with a 404 from a machine-generated link.
      ignoreTrailingSlash: true,
    },
  })

  // The single object handlers reach for when they need configuration or a
  // repository the api layer does not own. Decorated before the routes scope so
  // it is inherited by every plugin and every handler below.
  fastify.decorate('kip', { config, app })

  await fastify.register(errorPlugin)
  await fastify.register(securityPlugin)
  await fastify.register(rateLimitPlugin, { config })
  await fastify.register(formbody)
  // Registers @fastify/cookie itself, so cookie support is never mounted twice.
  await fastify.register(sessionPlugin, { config, app })

  // Outside the version prefix on purpose: a supervisor should not have to know
  // which API version is deployed to know whether the process is alive.
  await fastify.register(healthRoutes, { app, config })

  await fastify.register(
    async (api) => {
      await api.register(metaRoutes, { config, app })
      await api.register(referenceRoutes, { app })
      await api.register(businessRoutes, { app })
      await api.register(authRoutes, { config, app })
      await api.register(marketplaceRoutes, { app })
      await api.register(insightRoutes, { config, app })
      await api.register(adminBusinessRoutes, { app })
      await api.register(adminImportRoutes, { app })
    },
    { prefix: config.api.prefix },
  )

  // The website is a replaceable interface over the engine, so it is served from a
  // plain folder and nothing above this line knows it exists. A missing folder
  // means API only, which is a supported way to run this.
  if (web && fs.existsSync(WEB_ROOT)) {
    await fastify.register(fastifyStatic, {
      root: WEB_ROOT,
      prefix: '/',
      index: ['index.html'],
    })
  }

  return fastify
}
