import cookie from '@fastify/cookie'
import fp from 'fastify-plugin'
import { can } from '../../core/auth.js'
import { ForbiddenError, UnauthenticatedError } from '../../core/errors.js'

/**
 * Session authentication.
 *
 * Two ways in, on purpose. A browser gets an HttpOnly cookie, so the token is
 * never reachable from JavaScript and a cross-site bug cannot read it. A phone
 * app or the future Ask Kampala assistant sends `Authorization: Bearer`, because
 * neither has a cookie jar. Both resolve through the same session table and the
 * same role table, so there is exactly one definition of who is allowed to do
 * what.
 *
 * Nothing here decides *whether* an action is allowed. Routes ask for a
 * capability by name, and the role table in core/auth.js answers.
 */

function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

async function sessionPlugin(fastify, { config, app }) {
  await fastify.register(cookie, { secret: config.auth.sessionSecret })

  // A handful of routes need to build absolute-ish urls (`Location` on create)
  // and a few need to hash by the same secret. Both are configuration, so they
  // are configuration here too, once, rather than threaded through every plugin.
  fastify.decorate('settings', config)

  fastify.decorateRequest('user', null)
  fastify.decorateRequest('session', null)
  fastify.decorateRequest('authenticated', false)
  fastify.decorateRequest('sessionToken', null)

  fastify.addHook('onRequest', async (request) => {
    // The cookie is written signed, so what arrives here is `s:<token>.<sig>`,
    // not the token. It has to be unsign()'d before it can be looked up, and an
    // invalid signature has to be treated as no token at all rather than as a
    // string to hash.
    const raw = request.cookies?.[config.auth.cookieName]
    let token = bearerToken(request)
    if (raw) {
      const unsigned = request.unsignCookie(raw)
      token = unsigned.valid && unsigned.value ? unsigned.value : null
    }
    if (!token) return

    const session = app.sessions.resolve(token)
    if (!session) return
    const user = app.users.findById(session.userId)
    // A session can outlive the account it points at: the user may have been
    // deactivated or deleted after the token was issued. The join in the
    // repository filters those out, but a disabled user can still be sitting in
    // this process's view of the row.
    if (!user || user.status !== 'active') return

    request.sessionToken = token
    request.session = session
    request.user = user
    request.authenticated = true
  })

  /** preHandler factory: any signed-in user. */
  fastify.decorate('requireAuth', function requireAuth() {
    return async function authenticate(request) {
      if (!request.authenticated) {
        throw new UnauthenticatedError('Sign in to continue.')
      }
    }
  })

  /**
   * preHandler factory: a signed-in user whose role grants `capability`.
   *
   * Checks authentication first so a signed-out caller always gets 401 rather
   * than a 403, which would otherwise confirm that the endpoint exists and is
   * merely closed.
   */
  fastify.decorate('requireCapability', function requireCapability(capability) {
    return async function authorise(request) {
      if (!request.authenticated) {
        throw new UnauthenticatedError('Sign in to continue.')
      }
      if (!can(request.user.role, capability)) {
        throw new ForbiddenError(
          `Your role (${request.user.role}) cannot ${capability.replace(':', ' ')}.`,
        )
      }
    }
  })

  /** Issues the cookie a browser session needs. `secure` follows the protocol. */
  fastify.decorate('setSessionCookie', function setSessionCookie(reply, token, expiresAt) {
    reply.setCookie(config.auth.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: reply.request.protocol === 'https',
      expires: new Date(expiresAt),
      signed: true,
    })
  })

  fastify.decorate('clearSessionCookie', function clearSessionCookie(reply) {
    reply.clearCookie(config.auth.cookieName, { path: '/' })
  })
}

export default fp(sessionPlugin, { name: 'kip-session' })
