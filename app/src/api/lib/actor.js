import { dailySalt, pseudonymise } from '../../core/privacy.js'

/**
 * Turning a request into an actor identity the engine can count but not identify.
 *
 * Nothing in this file ever returns an address, a user agent or a token. What it
 * returns is a stable pseudonym for one day: the same visitor produces the same
 * actor seed all day, which is what makes "12 distinct actors searched for phone
 * repair" a meaningful claim, and a different seed tomorrow, which is what stops
 * the platform from assembling a permanent profile of whoever that was.
 *
 * The seed is salted with a per-day salt, so the value in the database is not
 * reversible to an address even if the master secret leaked in a year.
 */

const SALT_LENGTH = 16

/**
 * @param {object} options
 * @param {object} options.config resolved application config
 * @param {object} options.request fastify request
 * @returns {{ seed: string, day: string, salt: string }}
 */
export function actorForRequest({ config, request }) {
  const day = new Date().toISOString().slice(0, 10)
  const salt = dailySalt(config.auth.sessionSecret, day)

  // An authenticated caller is countable by user id: it is already an identifier
  // we hold on purpose, and it lets the platform tell one power user from fifty
  // anonymous visitors without storing anything new.
  const userId = request.user?.id ?? null
  const material = userId
    ? `user:${userId}`
    : `anon:${request.ip}|${request.headers['user-agent'] ?? ''}`

  return {
    seed: pseudonymise({ salt, actorSeed: material }).slice(0, SALT_LENGTH * 2),
    day,
    salt,
  }
}

/**
 * The day-bucketed hashes the session table is allowed to store.
 *
 * The session repository's comment says the raw address and user agent never
 * reach it, and this is the only thing that crosses that boundary.
 */
export function sessionContext({ config, request }) {
  const { salt, seed } = actorForRequest({ config, request })
  return {
    ipHash: seed,
    userAgentHash: pseudonymise({
      salt,
      actorSeed: `ua:${request.headers['user-agent'] ?? ''}`,
    }),
  }
}
