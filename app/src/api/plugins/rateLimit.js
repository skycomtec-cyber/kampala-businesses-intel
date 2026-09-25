import fp from 'fastify-plugin'
import { httpError } from './errors.js'

/**
 * A fixed-window rate limiter, in process memory.
 *
 * Why not a dependency: the platform is single-process SQLite, so a shared store
 * would be a distributed-systems problem bought for a single-machine problem. The
 * limit this actually protects is "a script hammering search and burning CPU and
 * signal", and a per-process counter stops that. If this ever runs behind more
 * than one instance, the swap is this one file.
 *
 * Counters are keyed by window, so an expired window is simply not found and the
 * next write replaces it, which is also why the sweep below only has to clean up
 * keys for callers who have since gone quiet.
 */

const SWEEP_INTERVAL_MS = 5 * 60_000

async function rateLimitPlugin(fastify, { config }) {
  const limits = config.api.rateLimit
  const buckets = new Map()

  const sweeper = setInterval(() => {
    const current = Math.floor(Date.now() / SWEEP_INTERVAL_MS)
    for (const [key, bucket] of buckets) {
      if (bucket.window < current) buckets.delete(key)
    }
  }, SWEEP_INTERVAL_MS)
  // Never hold the process open for a housekeeping timer.
  sweeper.unref?.()

  fastify.addHook('onClose', async () => {
    clearInterval(sweeper)
  })

  /**
   * Returns a preHandler hook. Attaching it per route, rather than globally, is
   * deliberate: an endpoint without a limit is a decision someone made, not an
   * oversight nobody noticed.
   */
  fastify.decorate('enforceRateLimit', function enforceRateLimit(name) {
    const limit = limits[name]
    if (!limit) {
      throw new Error(`No rate limit is configured for "${name}".`)
    }

    return async function rateLimitHandler(request, reply) {
      // An authenticated caller is limited by account, not by address, so an
      // office full of people behind one NAT does not spend one person's budget
      // and a stolen cookie cannot be spread across rotating addresses.
      const actor = request.user?.id ?? request.ip ?? 'unknown'
      const window = Math.floor(Date.now() / limit.windowMs)
      const key = `${name}:${actor}`
      const existing = buckets.get(key)

      const count = existing && existing.window === window ? existing.count + 1 : 1
      buckets.set(key, { window, count })

      const resetAt = (window + 1) * limit.windowMs
      reply.header('x-ratelimit-limit', limit.max)
      reply.header('x-ratelimit-remaining', Math.max(0, limit.max - count))
      reply.header('x-ratelimit-reset', new Date(resetAt).toISOString())

      if (count > limit.max) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
        reply.header('retry-after', retryAfter)
        throw httpError(
          429,
          'rate_limited',
          'Too many requests. Slow down and try again shortly.',
          { limit: name, max: limit.max, windowMs: limit.windowMs, retryAfterSeconds: retryAfter },
        )
      }
    }
  })

  /** Test and diagnostics hook: forget every counter. */
  fastify.decorate('resetRateLimits', function resetRateLimits() {
    buckets.clear()
  })
}

export default fp(rateLimitPlugin, { name: 'kip-rate-limit' })
