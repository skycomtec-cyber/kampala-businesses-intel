import { newId, newToken } from '../../core/identifiers.js'
import { buildClaim, assertDecisionForStatus } from '../../core/claims.js'
import { contactPointsLikelySameBusiness } from '../../core/business.js'
import { digestsMatch, hashOpaqueToken } from '../../core/auth.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, nowIso, toSqlBool, fromSqlBool } from '../mapping.js'
import { normalisePagination, where, likeParam, resolveOrder } from './common.js'

/**
 * Business claims.
 *
 * A claim is the only path by which a member of the public becomes an account
 * holder on this platform, and it is deliberately indirect: a person says "this
 * listing is mine" and how they can be reached, an operator decides whether to
 * believe them, and only the decision creates the account. There is no route that
 * turns a submission into ownership on its own.
 *
 * Two facts are written at submission time that are never recomputed:
 *
 *   - `matches_contact`, whether the claimant's email or phone already appears on
 *     the listing. It is a snapshot of the evidence as it stood when the claim was
 *     made, so an operator editing the contact points afterwards cannot
 *     retrospectively manufacture a match.
 *   - the reference, so the claim can be quoted over the phone like a marketplace
 *     request.
 *
 * The account a grant creates is a `provider`: the narrowest role on the
 * platform, scoped to the listings it owns by the provider routes rather than by
 * a broad capability. That is why the grant lives here and not in the user
 * repository: it is a claim decision that happens to also create an account, and
 * splitting it across two layers is how the two halves drift apart.
 */

const CLAIM_COLUMNS = `
  c.id, c.reference, c.business_id, c.user_id, c.status, c.claimed_as, c.relation,
  c.contact_email, c.contact_phone, c.evidence, c.matches_contact, c.reviewer_id,
  c.reason, c.decided_at, c.created_at, c.updated_at
`

const LIST_SORTS = Object.freeze({
  newest: 'c.created_at DESC',
  oldest: 'c.created_at ASC',
  reference: 'c.reference ASC',
})

const LIST_JOIN = `
  FROM business_claim c
  JOIN business b ON b.id = c.business_id
  LEFT JOIN app_user u ON u.id = c.user_id
`

export function createClaimsRepository(db, config, deps = {}) {
  const { businesses, users, passwordResets } = deps

  const insert = db.prepare(
    `INSERT INTO business_claim (
       id, reference, business_id, user_id, status, claimed_as, relation,
       contact_email, contact_phone, evidence, matches_contact, access_token_hash
     ) VALUES (
       @id, @reference, @businessId, @userId, @status, @claimedAs, @relation,
       @contactEmail, @contactPhone, @evidence, @matchesContact, @accessTokenHash
     )`,
  )
  const selectById = db.prepare(`SELECT ${CLAIM_COLUMNS} FROM business_claim c WHERE c.id = ?`)
  const selectByReference = db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM business_claim c WHERE c.reference = ?`,
  )
  const selectAccessTokenHash = db.prepare(
    `SELECT access_token_hash FROM business_claim WHERE id = ?`,
  )
  const selectCountForYear = db.prepare(
    `SELECT COUNT(*) AS total FROM business_claim WHERE created_at >= ?`,
  )
  const selectOpenForBusiness = db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM business_claim c
      WHERE c.business_id = ? AND c.status IN ('pending', 'granted')
      ORDER BY c.created_at DESC LIMIT 1`,
  )
  const selectGrantedForBusiness = db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM business_claim c
      WHERE c.business_id = ? AND c.status = 'granted'
      ORDER BY c.decided_at DESC LIMIT 1`,
  )
  const selectOwnedClaim = db.prepare(
    `SELECT 1 AS present FROM business_claim
      WHERE business_id = ? AND user_id = ? AND status = 'granted' LIMIT 1`,
  )
  const selectOwnedBusinessIds = db.prepare(
    `SELECT business_id FROM business_claim
      WHERE user_id = ? AND status = 'granted'
      ORDER BY decided_at DESC`,
  )
  const updateDecision = db.prepare(
    `UPDATE business_claim
        SET status = @status,
            user_id = @userId,
            reviewer_id = @reviewerId,
            reason = @reason,
            decided_at = @decidedAt,
            updated_at = @now
      WHERE id = @id`,
  )
  const countByStatus = db.prepare(
    `SELECT status, COUNT(*) AS total FROM business_claim GROUP BY status`,
  )
  const selectContactBusiness = db.prepare(
    `SELECT business_id FROM contact_point WHERE id = ?`,
  )
  const selectServiceBusiness = db.prepare(
    `SELECT business_id FROM service WHERE id = ?`,
  )
  const selectProductBusiness = db.prepare(
    `SELECT business_id FROM product WHERE id = ?`,
  )

  function claimRow(row) {
    if (!row) return null
    const record = camelizeRow(row)
    record.matchesContact = fromSqlBool(record.matchesContact)
    return record
  }

  function requireClaim(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('BusinessClaim', id)
    return row
  }

  /**
   * Human-facing reference, e.g. CLM-2026-00007.
   *
   * Same construction as a marketplace request: the year is in the prefix and the
   * sequence is counted inside the insert's transaction, so a reference written
   * down today still resolves after a restore from backup.
   */
  function nextReference(at) {
    const year = new Date(at).getUTCFullYear()
    const total = selectCountForYear.get(`${year}-01-01T00:00:00.000Z`).total
    return `CLM-${year}-${String(total + 1).padStart(5, '0')}`
  }

  /**
   * Whether the claimant's own contact details already appear on the listing.
   *
   * Reuses the platform's existing notion of two contacts meaning the same thing
   * (`contactPointsLikelySameBusiness`), so a claimant who types "0772 123 456"
   * matches a listing that stores "+256772123456". A phone match also crosses the
   * phone/whatsapp distinction, because they are the same digits and the same
   * business.
   */
  function computeMatchesContact(businessId, evidence) {
    const contacts = businesses ? businesses.contacts(businessId) : []
    if (contacts.length === 0) return false
    const claimed = []
    if (evidence.contactEmail) claimed.push({ kind: 'email', value: evidence.contactEmail })
    if (evidence.contactPhone) claimed.push({ kind: 'phone', value: evidence.contactPhone })
    return claimed.some((left) =>
      contacts.some((right) => contactPointsLikelySameBusiness(left, right)),
    )
  }

  const repository = {
    /**
     * Submits a claim.
     *
     * Anonymous by design: the claimant does not have an account yet, so the only
     * thing proving the claim is theirs is an opaque token returned exactly once,
     * stored as an HMAC. A business can hold at most one open claim at a time,
     * which stops a listing being flooded with competing applications and makes
     * "the pending claim" a singular thing an operator can point at.
     */
    create(input) {
      const business = businesses ? businesses.findById(input.businessId) : null
      if (!business) throw new NotFoundError('Business', input.businessId)

      const open = selectOpenForBusiness.get(business.id)
      if (open) {
        throw new ConflictError(
          open.status === 'granted'
            ? 'That listing has already been claimed and is looked after by its owner.'
            : 'There is already a claim pending for that listing.',
          { businessId: business.id, existingReference: open.reference, status: open.status },
        )
      }

      const at = input.at ?? nowIso()
      const built = buildClaim({ ...input, matchesContact: false })
      const matchesContact = computeMatchesContact(business.id, built)
      const accessToken = newToken()
      const accessTokenHash = hashOpaqueToken(accessToken, config.auth.sessionSecret)
      const id = newId()

      const write = db.transaction(() => {
        insert.run({
          id,
          reference: nextReference(at),
          businessId: business.id,
          userId: null,
          status: 'pending',
          claimedAs: built.claimedAs,
          relation: built.relation,
          contactEmail: built.contactEmail,
          contactPhone: built.contactPhone,
          evidence: built.evidence,
          matchesContact: toSqlBool(matchesContact),
          accessTokenHash,
        })
      })
      write()

      return { ...repository.requireById(id), accessToken }
    },

    findById(id) {
      return claimRow(selectById.get(id))
    },

    findByReference(reference) {
      return claimRow(selectByReference.get(reference))
    },

    requireById(id) {
      return claimRow(requireClaim(id))
    },

    requireByReference(reference) {
      const row = selectByReference.get(reference)
      if (!row) throw new NotFoundError('BusinessClaim', reference)
      return claimRow(row)
    },

    /**
     * Whether a token grants control of a claim.
     *
     * Compares HMACs, never tokens, and returns false rather than throwing for a
     * missing row so a caller can treat "wrong token" and "no such claim" alike.
     */
    verifyAccessToken(claimId, token) {
      if (typeof token !== 'string' || token.length < 16) return false
      const row = selectAccessTokenHash.get(claimId)
      if (!row?.access_token_hash) return false
      return digestsMatch(
        row.access_token_hash,
        hashOpaqueToken(token, config.auth.sessionSecret),
      )
    },

    /** The granted claim for a listing, if it has one. */
    grantedForBusiness(businessId) {
      return claimRow(selectGrantedForBusiness.get(businessId))
    },

    /** Whether this user looks after this listing. The provider ownership check. */
    isOwner(userId, businessId) {
      if (!userId || !businessId) return false
      return Boolean(selectOwnedClaim.get(businessId, userId))
    },

    /** The business ids a provider owns, newest grant first. */
    ownedBusinessIds(userId) {
      return selectOwnedBusinessIds.all(userId).map((row) => row.business_id)
    },

    /** The listings a provider owns, as full business rows. */
    ownedBusinesses(userId) {
      return repository
        .ownedBusinessIds(userId)
        .map((businessId) => (businesses ? businesses.findById(businessId) : null))
        .filter(Boolean)
    },

    /** The business a contact point belongs to, or null. */
    contactBusinessId(contactId) {
      return selectContactBusiness.get(contactId)?.business_id ?? null
    },

    serviceBusinessId(serviceId) {
      return selectServiceBusiness.get(serviceId)?.business_id ?? null
    },

    productBusinessId(productId) {
      return selectProductBusiness.get(productId)?.business_id ?? null
    },

    /**
     * The review queue.
     *
     * Status filters are optional and the default is everything, because the queue
     * an operator works is "what is waiting", and a queue that cannot show what was
     * just decided away cannot be checked.
     */
    list({ status, businessId, search, sort = 'newest', limit, offset } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}
      if (status) {
        conditions.push('c.status = @status')
        params.status = status
      }
      if (businessId) {
        conditions.push('c.business_id = @businessId')
        params.businessId = businessId
      }
      if (search) {
        conditions.push(
          `(c.reference LIKE @search ESCAPE '\\'
            OR c.claimed_as LIKE @search ESCAPE '\\'
            OR b.name LIKE @search ESCAPE '\\'
            OR c.contact_email LIKE @search ESCAPE '\\')`,
        )
        params.search = likeParam(search)
      }
      const whereSql = where(conditions)
      const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)

      const rows = db
        .prepare(
          `SELECT ${CLAIM_COLUMNS}, b.name AS business_name, b.slug AS business_slug,
                  b.status AS business_status, b.verification_state AS business_verification_state,
                  b.capability_level AS business_capability_level,
                  u.display_name AS owner_display_name, u.email AS owner_email
             ${LIST_JOIN}
             ${whereSql}
             ORDER BY ${order}, c.id ASC
             LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const total = db.prepare(`SELECT COUNT(*) AS total ${LIST_JOIN} ${whereSql}`).get(params).total
      return { total, items: rows.map(claimRow) }
    },

    /** Counts per status, including zeroes, for an operator dashboard. */
    statusCounts() {
      const counts = {}
      for (const row of countByStatus.all()) counts[row.status] = row.total
      return counts
    },

    /**
     * Withdraws a pending claim.
     *
     * Only a pending claim can be withdrawn. A granted one is ownership and is
     * ended by a revocation, and a rejected or already-withdrawn one is settled;
     * a fresh claim is the way back in either way.
     */
    withdraw(id) {
      const current = repository.requireById(id)
      if (current.status !== 'pending') {
        throw new ConflictError(`A ${current.status} claim cannot be withdrawn.`, {
          status: current.status,
        })
      }
      const at = nowIso()
      updateDecision.run({
        id,
        status: 'withdrawn',
        userId: current.userId,
        reviewerId: current.reviewerId,
        reason: current.reason,
        decidedAt: at,
        now: at,
      })
      return repository.requireById(id)
    },

    /**
     * Records an operator's decision about a claim, and for a grant, carries out
     * everything that decision implies in one transaction.
     *
     * The grant is the interesting one, and the reason it lives here: approving a
     * claim creates the provider account, hands the listing to it, and issues a
     * one-time password-reset token (there is no mail transport, so the token is
     * the only way to deliver the account). If the account creation succeeded and
     * the state change failed, the platform would have an account with no listing
     * and a claim that still looked open; doing all three here makes that
     * impossible.
     */
    decide(id, { decision, actor = null, reason = null, passwordTtlHours = 24 } = {}) {
      const current = repository.requireById(id)
      assertDecisionForStatus(current.status, decision)
      if ((decision === 'reject' || decision === 'revoke') && !String(reason ?? '').trim()) {
        throw new ValidationError(`A claim cannot be ${decision}ed without a reason.`, {
          field: 'reason',
        })
      }

      const at = nowIso()
      const base = {
        id,
        reviewerId: actor?.id ?? null,
        reason: reason ?? null,
        decidedAt: at,
        now: at,
      }

      if (decision === 'grant') {
        const business = businesses.requireById(current.businessId)

        // A grant creates an account, and an account needs somewhere to deliver
        // its password reset, so a claim with no email cannot be granted. The
        // operator has to ask the claimant for one first.
        if (!current.contactEmail) {
          throw new ValidationError(
            'A claim needs a contact email before it can be granted, so the owner can sign in.',
            { field: 'contactEmail' },
          )
        }

        const existingClaim = selectGrantedForBusiness.get(business.id)
        if (existingClaim && existingClaim.id !== current.id) {
          throw new ConflictError('That listing has already been granted to somebody else.', {
            businessId: business.id,
            existingReference: existingClaim.reference,
          })
        }

        const write = db.transaction(() => {
          let owner = users.findByEmail(current.contactEmail)
          let passwordResetToken = null
          if (owner) {
            if (owner.role !== 'provider') {
              throw new ConflictError(
                'That email already belongs to a staff account, which cannot also own a listing.',
                { field: 'contactEmail' },
              )
            }
          } else {
            // The password is random and discarded on purpose: the only way in is
            // the reset token below, so there is no initial credential to leak.
            owner = users.create({
              email: current.contactEmail,
              displayName: current.claimedAs,
              password: newToken(24),
              role: 'provider',
            })
          }
          passwordResetToken = passwordResets.issue(owner.id, passwordTtlHours)

          updateDecision.run({
            ...base,
            status: 'granted',
            userId: owner.id,
          })
          // `claimed` is the capability level that names this situation exactly.
          // It is set only when the listing is not already trusted further, so a
          // claim cannot demote a listing an operator has already documented.
          if (business.capabilityLevel === 'unverified') {
            businesses.setCapabilityLevel(business.id, 'claimed')
          }
          return { owner, passwordResetToken }
        })

        const { owner, passwordResetToken } = write()
        return {
          claim: repository.requireById(id),
          owner,
          passwordResetToken,
        }
      }

      if (decision === 'revoke') {
        const write = db.transaction(() => {
          updateDecision.run({
            ...base,
            status: 'revoked',
            userId: current.userId,
          })
          const business = businesses.requireById(current.businessId)
          if (business.capabilityLevel === 'claimed') {
            businesses.setCapabilityLevel(business.id, 'unverified')
          }
        })
        write()
        return { claim: repository.requireById(id) }
      }

      // reject
      updateDecision.run({
        ...base,
        status: 'rejected',
        userId: current.userId,
      })
      return { claim: repository.requireById(id) }
    },

    /** A claim with the listing it concerns, for a reviewer. */
    detail(id) {
      const claim = repository.requireById(id)
      return claimRow(
        db
          .prepare(
            `SELECT ${CLAIM_COLUMNS}, b.name AS business_name, b.slug AS business_slug,
                    b.status AS business_status,
                    b.verification_state AS business_verification_state,
                    b.capability_level AS business_capability_level
               FROM business_claim c
               JOIN business b ON b.id = c.business_id
              WHERE c.id = ?`,
          )
          .get(id),
      )
    },
  }

  return repository
}
