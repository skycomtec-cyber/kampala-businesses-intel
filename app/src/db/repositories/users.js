import { newId, newToken, isValidEmail } from '../../core/identifiers.js'
import {
  assertRole,
  assertPasswordStrength,
  hashPassword,
  verifyPassword,
  needsRehash,
  newSessionToken,
  hashSessionToken,
  SCRYPT_PARAMS,
} from '../../core/auth.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso, compact } from '../mapping.js'

/**
 * Users and sessions.
 *
 * Two details are worth stating outright because they are the difference
 * between a leaked database and a leaked database:
 *
 *   1. Sessions store `token_hash`, never the token. The cookie value is
 *      HMAC'd with the session secret before it is written, so reading the
 *      sessions table does not yield a usable cookie.
 *   2. Passwords are hashed in core, with scrypt, before they reach this layer.
 *      No repository in the platform ever sees a plaintext password.
 */

const USER_COLUMNS = `
  id, email, email_normalised, display_name, role, status,
  created_at, updated_at, last_login_at
`

/** Strips the hash before a user record leaves the data layer. */
function publicUser(row) {
  if (!row) return null
  const user = camelizeRow(row)
  delete user.passwordHash
  return user
}

export function createUsersRepository(db, config) {
  const insert = db.prepare(
    `INSERT INTO app_user (
       id, email, email_normalised, display_name, password_hash, role, status
     ) VALUES (
       @id, @email, @emailNormalised, @displayName, @passwordHash, @role, @status
     )`,
  )
  const selectById = db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM app_user WHERE id = ?`)
  const selectByEmail = db.prepare(
    `SELECT ${USER_COLUMNS}, password_hash FROM app_user WHERE email_normalised = ?`,
  )
  const selectAll = db.prepare(
    `SELECT ${USER_COLUMNS} FROM app_user ORDER BY created_at DESC`,
  )
  const touchLogin = db.prepare(
    `UPDATE app_user SET last_login_at = @now, updated_at = @now WHERE id = @id`,
  )
  const updatePassword = db.prepare(
    `UPDATE app_user SET password_hash = @passwordHash, updated_at = @now WHERE id = @id`,
  )
  const updateProfile = db.prepare(
    `UPDATE app_user
        SET display_name = @displayName,
            role = @role,
            status = @status,
            updated_at = @now
      WHERE id = @id`,
  )
  const countAdmins = db.prepare(
    `SELECT COUNT(*) AS total FROM app_user WHERE role = 'admin' AND status = 'active'`,
  )

  return {
    create({ email, password, displayName, role = 'viewer', status = 'active' }) {
      if (!isValidEmail(email)) {
        throw new ValidationError(`"${email}" is not a valid email address.`, {
          field: 'email',
        })
      }
      const normalised = email.trim().toLowerCase()
      if (selectByEmail.get(normalised)) {
        throw new ConflictError('An account with that email already exists.', {
          field: 'email',
        })
      }
      const name = String(displayName ?? '').trim()
      if (name.length < 2 || name.length > 120) {
        throw new ValidationError('A display name must be 2 to 120 characters.', {
          field: 'displayName',
        })
      }
      assertPasswordStrength(password, config.auth.minPasswordLength)
      assertRole(role)

      const id = newId()
      insert.run({
        id,
        email: email.trim(),
        emailNormalised: normalised,
        displayName: name,
        passwordHash: hashPassword(password, SCRYPT_PARAMS),
        role,
        status,
      })
      return this.findById(id)
    },

    findById(id) {
      return publicUser(selectById.get(id))
    },

    findByEmail(email) {
      if (typeof email !== 'string') return null
      return publicUser(selectByEmail.get(email.trim().toLowerCase()))
    },

    /**
     * The one place a password is compared. Returns null on failure rather than
     * throwing, so a caller cannot accidentally treat "no such user" and "wrong
     * password" as different outcomes and leak which emails are registered.
     */
    authenticate(email, password) {
      const row =
        typeof email === 'string'
          ? selectByEmail.get(email.trim().toLowerCase())
          : null
      if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) return null
      if (row.status !== 'active') return null
      return publicUser(row)
    },

    list() {
      return camelizeRows(selectAll.all())
    },

    recordLogin(id) {
      const now = nowIso()
      touchLogin.run({ id, now })
      return this.findById(id)
    },

    /**
     * Upgrades the stored hash when the KDF parameters have moved on. Called
     * after a successful sign-in so cost parameters can be raised without
     * invalidating anyone's password.
     */
    upgradePasswordHashIfNeeded(userId, password) {
      const row = selectById.get(userId)
      if (!row || !needsRehash(row.password_hash, SCRYPT_PARAMS)) return false
      updatePassword.run({
        id: userId,
        passwordHash: hashPassword(password, SCRYPT_PARAMS),
        now: nowIso(),
      })
      return true
    },

    changePassword(userId, currentPassword, nextPassword) {
      const row = selectById.get(userId)
      if (!row) throw new NotFoundError('User', userId)
      if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
        throw new ValidationError('The current password is incorrect.', {
          field: 'currentPassword',
        })
      }
      assertPasswordStrength(nextPassword, config.auth.minPasswordLength)
      updatePassword.run({
        id: userId,
        passwordHash: hashPassword(nextPassword, SCRYPT_PARAMS),
        now: nowIso(),
      })
      return true
    },

    /**
     * Sets a password without knowing the current one.
     *
     * Reserved for the two flows that legitimately have no current password: an
     * admin resetting an account, and a completed password reset. The strength
     * rule is enforced here too, because "the reset link made it short" is not a
     * reason to accept a weak password.
     */
    setPassword(userId, password) {
      const row = selectById.get(userId)
      if (!row) throw new NotFoundError('User', userId)
      assertPasswordStrength(password, config.auth.minPasswordLength)
      updatePassword.run({
        id: userId,
        passwordHash: hashPassword(password, SCRYPT_PARAMS),
        now: nowIso(),
      })
      return true
    },

    update(userId, patch) {
      const current = selectById.get(userId)
      if (!current) throw new NotFoundError('User', userId)

      const next = {
        displayName: patch.displayName ?? current.display_name,
        role: patch.role ?? current.role,
        status: patch.status ?? current.status,
      }
      assertRole(next.role)
      if (!['active', 'disabled'].includes(next.status)) {
        throw new ValidationError(`Unknown user status "${next.status}".`)
      }

      // The last active admin cannot be demoted or disabled: the platform would
      // have no way back in without deleting the database.
      const losingAdmin =
        current.role === 'admin' &&
        current.status === 'active' &&
        (next.role !== 'admin' || next.status !== 'active')
      if (losingAdmin && countAdmins.get().total <= 1) {
        throw new ConflictError(
          'The last active administrator cannot be demoted or disabled.',
        )
      }

      updateProfile.run({ id: userId, ...next, now: nowIso() })
      return this.findById(userId)
    },

    count() {
      return selectAll.all().length
    },
  }
}

export function createSessionsRepository(db, config) {
  const insert = db.prepare(
    `INSERT INTO app_session (
       id, user_id, token_hash, expires_at, last_seen_at, ip_hash, user_agent_hash
     ) VALUES (
       @id, @userId, @tokenHash, @expiresAt, @lastSeenAt, @ipHash, @userAgentHash
     )`,
  )
  const selectByToken = db.prepare(
    `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at
       FROM app_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
  )
  const touch = db.prepare(
    `UPDATE app_session SET last_seen_at = ? WHERE id = ?`,
  )
  const deleteOne = db.prepare(`DELETE FROM app_session WHERE id = ?`)
  const deleteByToken = db.prepare(`DELETE FROM app_session WHERE token_hash = ?`)
  const deleteForUser = db.prepare(`DELETE FROM app_session WHERE user_id = ?`)
  const deleteExpired = db.prepare(`DELETE FROM app_session WHERE expires_at <= ?`)
  const listForUser = db.prepare(
    `SELECT id, created_at, expires_at, last_seen_at
       FROM app_session WHERE user_id = ? ORDER BY last_seen_at DESC`,
  )

  function ttlMs() {
    return config.auth.sessionTtlHours * 3600 * 1000
  }

  /**
   * `context` holds only the day-bucketed hashes the api layer derives. The raw
   * address and user agent never reach this function, so they cannot reach the
   * table even if a caller passes them by mistake.
   */
  return {
    create({ userId, context = {} }) {
      const token = newSessionToken()
      const id = newId()
      const now = Date.now()
      insert.run({
        id,
        userId,
        tokenHash: hashSessionToken(token, config.auth.sessionSecret),
        expiresAt: new Date(now + ttlMs()).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        ipHash: context.ipHash ?? null,
        userAgentHash: context.userAgentHash ?? null,
      })
      return { id, token, expiresAt: new Date(now + ttlMs()).toISOString() }
    },

    resolve(token) {
      if (typeof token !== 'string' || token.length < 16) return null
      const row = selectByToken.get(
        hashSessionToken(token, config.auth.sessionSecret),
        nowIso(),
      )
      if (!row) return null
      touch.run(nowIso(), row.id)
      return camelizeRow(row)
    },

    destroy(token) {
      if (typeof token !== 'string' || token.length < 16) return false
      return deleteByToken.run(hashSessionToken(token, config.auth.sessionSecret)).changes > 0
    },

    destroyById(id) {
      return deleteOne.run(id).changes > 0
    },

    destroyAllForUser(userId) {
      return deleteForUser.run(userId).changes
    },

    listForUser(userId) {
      return camelizeRows(listForUser.all(userId))
    },

    purgeExpired() {
      return deleteExpired.run(nowIso()).changes
    },
  }
}

export function createPasswordResetRepository(db, config) {
  // Reset tokens are single-use and opaque. Only their hash is stored, and they
  // expire, so a stolen token is useful for minutes rather than indefinitely.
  const insert = db.prepare(
    `INSERT INTO password_reset (
       id, user_id, token_hash, expires_at, created_at
     ) VALUES (@id, @userId, @tokenHash, @expiresAt, @createdAt)`,
  )
  const selectByToken = db.prepare(
    `SELECT id, user_id, expires_at, used_at
       FROM password_reset WHERE token_hash = ?`,
  )
  const markUsed = db.prepare(
    `UPDATE password_reset SET used_at = ? WHERE id = ? AND used_at IS NULL`,
  )
  const deleteExpired = db.prepare(
    `DELETE FROM password_reset WHERE expires_at <= ?`,
  )

  return {
    issue(userId, ttlHours = 1) {
      const token = newToken()
      insert.run({
        id: newId(),
        userId,
        tokenHash: hashSessionToken(token, config.auth.sessionSecret),
        expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000).toISOString(),
        createdAt: nowIso(),
      })
      return token
    },
    consume(token) {
      if (typeof token !== 'string' || token.length < 16) return null
      const row = selectByToken.get(hashSessionToken(token, config.auth.sessionSecret))
      if (!row || row.used_at || row.expires_at <= nowIso()) return null
      // The `used_at IS NULL` guard makes this atomic: two concurrent resets
      // with the same token cannot both succeed.
      if (markUsed.run(nowIso(), row.id).changes !== 1) return null
      return row.user_id
    },
    purgeExpired() {
      return deleteExpired.run(nowIso()).changes
    },
  }
}

export function createAuditRepository(db) {
  const insert = db.prepare(
    `INSERT INTO audit_log (
       id, actor_id, actor_role, action, entity_type, entity_id, reason, before_json, after_json
     ) VALUES (
       @id, @actorId, @actorRole, @action, @entityType, @entityId, @reason, @beforeJson, @afterJson
     )`,
  )
  const selectByEntity = db.prepare(
    `SELECT * FROM audit_log
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
  const selectRecent = db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
  const selectByActor = db.prepare(
    `SELECT * FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )

  return {
    record({
      actorId = null,
      actorRole = null,
      action,
      entityType,
      entityId = null,
      reason = null,
      before = null,
      after = null,
    }) {
      insert.run({
        id: newId(),
        actorId,
        actorRole,
        action,
        entityType,
        entityId: entityId ? String(entityId) : null,
        reason: reason ? String(reason) : null,
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: after ? JSON.stringify(after) : null,
      })
    },
    forEntity(entityType, entityId, limit = 50) {
      return camelizeRows(selectByEntity.all(entityType, entityId, limit))
    },
    recent(limit = 50) {
      return camelizeRows(selectRecent.all(limit))
    },
    forActor(actorId, limit = 50) {
      return camelizeRows(selectByActor.all(actorId, limit))
    },
  }
}
