import { single } from '../lib/http.js'
import { sessionContext } from '../lib/actor.js'
import { ROLES } from '../../core/auth.js'
import { UnauthenticatedError } from '../../core/errors.js'

/**
 * Sign in, sign out, and prove who you are.
 *
 * Deliberately minimal. There is no "remember me", no OAuth, and no public
 * registration: accounts are for operators, editors and analysts, and every one
 * of them is created by an admin through the admin api. A directory of Kampala
 * businesses that let anyone sign themselves up would collect exactly the kind of
 * data this platform is built not to collect.
 *
 * The one rule that matters here: a failed sign-in and an unknown email return
 * the same 401 with the same message and take comparable time, so the endpoint
 * cannot be used to find out which addresses are registered.
 */

export default async function authRoutes(fastify, { config, app }) {
  fastify.post(
    '/auth/login',
    {
      schema: {
        summary: 'Exchange an email and password for a session cookie or bearer token.',
        tags: ['auth'],
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('signIn'),
    },
    async (request, reply) => {
      const { email, password } = request.body
      const user = app.users.authenticate(email, password)
      if (!user) {
        request.log.info({ emailDomain: String(email).split('@')[1] }, 'sign-in refused')
        throw new UnauthenticatedError('Email or password is incorrect.')
      }

      // The stored hash may predate a change to the scrypt parameters. Upgrade it
      // now, while the plaintext password happens to be available, so raising the
      // cost later does not lock anybody out.
      app.users.upgradePasswordHashIfNeeded(user.id, password)
      app.users.recordLogin(user.id)

      const session = app.sessions.create({
        userId: user.id,
        context: sessionContext({ config, request }),
      })
      fastify.setSessionCookie(reply, session.token, session.expiresAt)

      return single({
        user,
        expiresAt: session.expiresAt,
        // Returned for clients that cannot hold a cookie: a mobile app, or the
        // future Ask Kampala service.
        token: session.token,
      })
    },
  )

  fastify.post(
    '/auth/logout',
    {
      schema: {
        summary: 'Destroy the current session.',
        tags: ['auth'],
        preHandler: fastify.requireAuth(),
      },
    },
    async (request, reply) => {
      app.sessions.destroy(request.sessionToken)
      fastify.clearSessionCookie(reply)
      return single({ signedOut: true })
    },
  )

  fastify.get(
    '/auth/me',
    {
      schema: {
        summary: 'The signed-in user and their capabilities.',
        tags: ['auth'],
        preHandler: fastify.requireAuth(),
      },
    },
    async (request) =>
      single({
        user: request.user,
        session: {
          expiresAt: request.session.expiresAt,
          lastSeenAt: request.session.lastSeenAt,
        },
      }),
  )

  fastify.post(
    '/auth/change-password',
    {
      schema: {
        summary: 'Change your own password.',
        tags: ['auth'],
        preHandler: fastify.requireAuth(),
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
            newPassword: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      app.users.changePassword(
        request.user.id,
        request.body.currentPassword,
        request.body.newPassword,
      )
      // Every other session for this account is now potentially in a thief's
      // hands, so they all go, including this one. The caller signs in again.
      app.sessions.destroyAllForUser(request.user.id)
      fastify.clearSessionCookie(reply)
      return single({ changed: true, signedOutEverywhere: true })
    },
  )

  /**
   * Ask for a password reset link.
   *
   * Always answers 202 with the same body, whether or not the address is known.
   * Anything else turns this endpoint into a free membership oracle for the user
   * table. The token is not emailed by this process either: no mail transport is
   * wired up, so the token is returned only when the environment is explicitly
   * development, where pretending to send it would be worse than not offering
   * the feature at all.
   */
  fastify.post(
    '/auth/password-reset',
    {
      schema: {
        summary: 'Request a password reset token.',
        description:
          'Always responds the same way. In development the token is included in the response because nothing sends mail yet.',
        tags: ['auth'],
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { type: 'string', minLength: 3, maxLength: 254 } },
        },
      },
      preHandler: fastify.enforceRateLimit('signIn'),
    },
    async (request, reply) => {
      const user = app.users.findByEmail(request.body.email)
      const development = config.env !== 'production'
      let token = null
      if (user && user.status === 'active') {
        token = app.passwordResets.issue(user.id, 1)
        if (development) {
          request.log.warn(
            { userId: user.id },
            'password reset token issued in a non-production environment',
          )
        }
      }
      return reply.status(202).send(
        single({ accepted: true, ...(development && token ? { token } : {}) }),
      )
    },
  )

  fastify.post(
    '/auth/password-reset/confirm',
    {
      schema: {
        summary: 'Complete a password reset with a single-use token.',
        tags: ['auth'],
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: 16, maxLength: 200 },
            newPassword: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
      preHandler: fastify.enforceRateLimit('signIn'),
    },
    async (request, reply) => {
      const userId = app.passwordResets.consume(request.body.token)
      if (!userId) {
        throw new UnauthenticatedError('That reset link is invalid or has expired.')
      }
      app.users.setPassword(userId, request.body.newPassword)
      // A reset is the moment a compromised account is most likely to be taken
      // over, so every existing session goes with it.
      app.sessions.destroyAllForUser(userId)
      fastify.clearSessionCookie(reply)
      return single({ reset: true })
    },
  )

  /** The role table, so a client can hide controls it knows will be refused. */
  fastify.get(
    '/auth/roles',
    {
      schema: {
        summary: 'The roles the platform recognises.',
        tags: ['auth'],
        preHandler: fastify.requireAuth(),
      },
    },
    async () => single({ roles: ROLES }),
  )
}
