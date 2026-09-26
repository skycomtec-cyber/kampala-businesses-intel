import { newId, newToken, slugify, disambiguateSlug } from '../../core/identifiers.js'
import { assertRequestStatus, assertUrgency } from '../../core/demand.js'
import { digestsMatch, hashOpaqueToken } from '../../core/auth.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso, toSqlBool, fromSqlBool } from '../mapping.js'
import { normalisePagination, where, likeParam, resolveOrder } from './common.js'

/**
 * The marketplace.
 *
 * A request is the highest-quality demand signal the platform has, because a
 * person stated it on purpose rather than typing it into a search box. That is
 * why requests are first-class rows with their own lifecycle rather than a
 * special case of a search.
 *
 * Requests may be posted anonymously. An anonymous request is linked to no user
 * and identified only by the day-bucketed actor hash for the request's lifetime,
 * so the marketplace works for someone who will never create an account without
 * the platform having to store anything about who they are. Because that leaves
 * nothing to prove ownership with, creation also issues an opaque access token
 * whose HMAC is the only thing stored.
 */

const REQUEST_COLUMNS = `
  id, reference, slug, title, description, category_id, location_id, status, urgency,
  requester_user_id, requester_bucket, is_anonymous, budget_min, budget_max, currency,
  accepts_used, accepts_recycled, source_id, wanted_by, expires_at, closed_at,
  created_at, updated_at
`

const LIST_SORTS = Object.freeze({
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
  urgency: `CASE r.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                            WHEN 'normal' THEN 2 ELSE 3 END ASC`,
  reference: 'r.reference ASC',
})

export function createMarketplaceRepository(db, config) {
  const insertRequest = db.prepare(
    `INSERT INTO request (
       id, reference, slug, title, description, category_id, location_id, status,
       urgency, requester_user_id, requester_bucket, is_anonymous, budget_min,
       budget_max, currency, accepts_used, accepts_recycled, source_id, wanted_by,
       expires_at, access_token_hash
     ) VALUES (
       @id, @reference, @slug, @title, @description, @categoryId, @locationId, @status,
       @urgency, @requesterUserId, @requesterBucket, @isAnonymous, @budgetMin,
       @budgetMax, @currency, @acceptsUsed, @acceptsRecycled, @sourceId, @wantedBy,
       @expiresAt, @accessTokenHash
     )`,
  )
  const selectAccessTokenHash = db.prepare(
    `SELECT access_token_hash FROM request WHERE id = ?`,
  )
  const selectById = db.prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE id = ?`)
  const selectBySlug = db.prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE slug = ?`)
  const selectByReference = db.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM request WHERE reference = ?`,
  )
  const selectSlugExists = db.prepare(`SELECT 1 AS present FROM request WHERE slug = ?`)
  const selectCountForYear = db.prepare(
    `SELECT COUNT(*) AS total FROM request WHERE created_at >= ?`,
  )
  const countByStatus = db.prepare(
    `SELECT status, COUNT(*) AS total FROM request GROUP BY status`,
  )
  const countOpenByLocation = db.prepare(
    `SELECT location_id, COUNT(*) AS total FROM request
      WHERE status = 'open' GROUP BY location_id`,
  )
  const timeToFirstOffer = db.prepare(
    `SELECT AVG(julianday(o.created_at) - julianday(r.created_at)) AS days
       FROM request r
       JOIN request_offer o ON o.request_id = r.id
      WHERE r.created_at >= ?`,
  )
  const expiringRequests = db.prepare(
    `SELECT id FROM request
      WHERE status IN ('open', 'matched') AND expires_at IS NOT NULL AND expires_at <= ?`,
  )
  const setStatus = db.prepare(
    `UPDATE request SET status = @status, updated_at = @now,
            closed_at = CASE WHEN @status IN ('fulfilled', 'cancelled', 'expired')
                             THEN @now ELSE closed_at END
      WHERE id = @id`,
  )
  const insertItem = db.prepare(
    `INSERT INTO request_item (
       id, request_id, name, slug, quantity, condition_preference, skill_id, notes
     ) VALUES (
       @id, @requestId, @name, @slug, @quantity, @conditionPreference, @skillId, @notes
     )`,
  )
  const selectItems = db.prepare(
    `SELECT * FROM request_item WHERE request_id = ? ORDER BY name ASC`,
  )
  const selectItem = db.prepare(`SELECT * FROM request_item WHERE id = ?`)
  const fillItem = db.prepare(
    `UPDATE request_item SET is_filled = 1 WHERE id = ?`,
  )
  const insertOffer = db.prepare(
    `INSERT INTO request_offer (id, request_id, business_id, message, price, status)
     VALUES (@id, @requestId, @businessId, @message, @price, @status)`,
  )
  // Everything, for the business that made the offer and for the requester.
  const selectOffers = db.prepare(
    `SELECT o.*, b.name AS business_name, b.slug AS business_slug
       FROM request_offer o
       JOIN business b ON b.id = o.business_id
      WHERE o.request_id = ?
      ORDER BY o.created_at ASC`,
  )
  // The public view. An offer names the business that made it, and a business
  // that is not published is a business the public is not supposed to know
  // exists yet, so an offer from one is not shown at all rather than shown
  // anonymously: an offer with no name on it is indistinguishable from a mistake.
  const selectPublicOffers = db.prepare(
    `SELECT o.*, b.name AS business_name, b.slug AS business_slug
       FROM request_offer o
       JOIN business b ON b.id = o.business_id
      WHERE o.request_id = ?
        AND b.status = 'active'
        AND b.verification_state = 'approved'
      ORDER BY o.created_at ASC`,
  )
  const selectOffer = db.prepare(
    `SELECT * FROM request_offer WHERE id = ? AND request_id = ?`,
  )
  const selectOfferByBusiness = db.prepare(
    `SELECT * FROM request_offer WHERE request_id = ? AND business_id = ?`,
  )
  const setOfferStatus = db.prepare(
    `UPDATE request_offer SET status = @status, updated_at = @now WHERE id = @id`,
  )
  const declineOthers = db.prepare(
    `UPDATE request_offer SET status = 'declined', updated_at = @now
      WHERE request_id = @requestId AND id <> @offerId AND status = 'submitted'`,
  )
  const insertStatusEvent = db.prepare(
    `INSERT INTO request_status_event (id, request_id, from_status, to_status, actor_id, note)
     VALUES (@id, @requestId, @fromStatus, @toStatus, @actorId, @note)`,
  )
  const selectStatusHistory = db.prepare(
    `SELECT * FROM request_status_event WHERE request_id = ? ORDER BY created_at ASC`,
  )
  const selectByActor = db.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM request WHERE requester_bucket = ? ORDER BY created_at DESC`,
  )
  const selectByUser = db.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM request WHERE requester_user_id = ? ORDER BY created_at DESC`,
  )
  const offersForBusiness = db.prepare(
    `SELECT o.*, r.title AS request_title, r.reference AS request_reference
       FROM request_offer o
       JOIN request r ON r.id = o.request_id
      WHERE o.business_id = ?
      ORDER BY o.created_at DESC`,
  )
  const openRequestsMatchingBusiness = db.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM request r
      WHERE r.status = 'open'
        AND r.category_id = ?
        AND r.location_id = ?
      ORDER BY
        CASE r.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END ASC,
        r.created_at ASC
      LIMIT ?`,
  )

  function requestRow(row) {
    const record = camelizeRow(row)
    record.isAnonymous = fromSqlBool(record.isAnonymous)
    record.acceptsUsed = fromSqlBool(record.acceptsUsed)
    record.acceptsRecycled = fromSqlBool(record.acceptsRecycled)
    return record
  }

  function requireRequest(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Request', id)
    return row
  }

  /**
   * Human-facing reference, e.g. KMP-2026-00042.
   *
   * Generated inside the same transaction as the insert, and the year prefix is
   * part of the reference so a number quoted over the phone two years from now
   * is still findable.
   */
  function nextReference(at) {
    const year = new Date(at).getUTCFullYear()
    const total = selectCountForYear.get(`${year}-01-01T00:00:00.000Z`).total
    return `KMP-${year}-${String(total + 1).padStart(5, '0')}`
  }

  function resolveSlug(preferred) {
    const base = slugify(preferred)
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const candidate = disambiguateSlug(base, attempt)
      if (!selectSlugExists.get(candidate)) return candidate
    }
    return `${base}-${newId().slice(0, 8)}`
  }

  const repository = {
    create(input) {
      const title = String(input.title ?? '').trim()
      if (title.length < 6 || title.length > 160) {
        throw new ValidationError('A request title must be 6 to 160 characters.', {
          field: 'title',
        })
      }
      if (!input.categoryId) {
        throw new ValidationError('A request must be in a category.', { field: 'categoryId' })
      }
      if (!input.locationId) {
        throw new ValidationError('A request must have a location.', { field: 'locationId' })
      }
      if (input.budgetMin != null && input.budgetMax != null && input.budgetMax < input.budgetMin) {
        throw new ValidationError('The maximum budget cannot be below the minimum.', {
          field: 'budgetMax',
        })
      }

      const urgency = assertUrgency(input.urgency ?? 'normal')
      const at = input.at ?? nowIso()
      const id = newId()
      // A signed-in requester proves ownership by authenticating, so they get no
      // token. Everyone else gets one, returned exactly once and never readable
      // from the row again.
      const accessToken = input.requesterUserId ? null : newToken()
      const accessTokenHash = accessToken
        ? hashOpaqueToken(accessToken, config.auth.sessionSecret)
        : null

      const write = db.transaction(() => {
        insertRequest.run({
          id,
          reference: nextReference(at),
          slug: resolveSlug(input.slug || title),
          title,
          description: input.description ?? null,
          categoryId: input.categoryId,
          locationId: input.locationId,
          status: 'open',
          urgency,
          requesterUserId: input.requesterUserId ?? null,
          requesterBucket: input.requesterBucket ?? null,
          isAnonymous: toSqlBool(input.requesterUserId ? false : true),
          budgetMin: numberOrNull(input.budgetMin),
          budgetMax: numberOrNull(input.budgetMax),
          currency: input.currency ?? 'UGX',
          acceptsUsed: toSqlBool(Boolean(input.acceptsUsed)),
          acceptsRecycled: toSqlBool(Boolean(input.acceptsRecycled)),
          sourceId: input.sourceId ?? null,
          wantedBy: input.wantedBy ?? null,
          expiresAt: input.expiresAt ?? null,
          accessTokenHash,
        })

        for (const item of input.items ?? []) {
          const name = String(item.name ?? '').trim()
          if (name.length < 2) continue
          insertItem.run({
            id: newId(),
            requestId: id,
            name,
            slug: slugify(name),
            quantity: Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
            conditionPreference: item.conditionPreference ?? 'any',
            skillId: item.skillId ?? null,
            notes: item.notes ?? null,
          })
        }

        insertStatusEvent.run({
          id: newId(),
          requestId: id,
          fromStatus: null,
          toStatus: 'open',
          actorId: input.requesterUserId ?? null,
          note: 'Request posted.',
        })
      })
      write()

      // The token rides out with the row it created and is never stored in the
      // clear, so it is not part of `data` on any later read.
      return accessToken
        ? { ...repository.requireById(id), accessToken }
        : repository.requireById(id)
    },

    /**
     * Whether a token grants control of a request.
     *
     * Compares HMACs rather than tokens, and returns false rather than throwing
     * for a missing row, so a caller can treat "wrong token" and "no such
     * request" identically.
     */
    verifyAccessToken(requestId, token) {
      if (typeof token !== 'string' || token.length < 16) return false
      const row = selectAccessTokenHash.get(requestId)
      if (!row?.access_token_hash) return false
      return digestsMatch(
        row.access_token_hash,
        hashOpaqueToken(token, config.auth.sessionSecret),
      )
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? requestRow(row) : null
    },

    findBySlug(slug) {
      const row = selectBySlug.get(slug)
      return row ? requestRow(row) : null
    },

    findByReference(reference) {
      const row = selectByReference.get(reference)
      return row ? requestRow(row) : null
    },

    requireById(id) {
      return requestRow(requireRequest(id))
    },

    /** A request with its items, offers and status history. */
    detail(id, { includePrivate = false } = {}) {
      const request = repository.requireById(id)
      return {
        ...request,
        items: camelizeRows(selectItems.all(id)).map((item) => ({
          ...item,
          isFilled: fromSqlBool(item.isFilled),
        })),
        offers: camelizeRows(
          (includePrivate ? selectOffers : selectPublicOffers).all(id),
        ).map((offer) => ({
          ...offer,
          price: numberOrNull(offer.price),
          // An offer is addressed to the requester. On a public view, who made
          // it and what it says is not published.
          ...(includePrivate ? {} : { message: null }),
        })),
        history: camelizeRows(selectStatusHistory.all(id)),
      }
    },

    list({
      status,
      urgency,
      categoryId,
      locationId,
      search,
      acceptsUsed = null,
      sort = 'newest',
      limit,
      offset,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}

      if (status) {
        conditions.push('r.status = @status')
        params.status = assertRequestStatus(status)
      }
      if (urgency) {
        conditions.push('r.urgency = @urgency')
        params.urgency = assertUrgency(urgency)
      }
      if (categoryId) {
        conditions.push('r.category_id = @categoryId')
        params.categoryId = categoryId
      }
      if (locationId) {
        conditions.push('r.location_id = @locationId')
        params.locationId = locationId
      }
      if (acceptsUsed !== null) {
        conditions.push('r.accepts_used = @acceptsUsed')
        params.acceptsUsed = toSqlBool(acceptsUsed)
      }
      if (search) {
        conditions.push(
          "(r.title LIKE @search ESCAPE '\\' OR r.description LIKE @search ESCAPE '\\')",
        )
        params.search = likeParam(search)
      }

      const whereSql = where(conditions)
      const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)
      const rows = db
        .prepare(
          `SELECT ${REQUEST_COLUMNS} FROM request r
            ${whereSql}
            ORDER BY ${order}, r.id ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM request r ${whereSql}`)
        .get(params).total

      return { total, items: rows.map(requestRow) }
    },

    forActor(requesterBucket) {
      return camelizeRows(selectByActor.all(requesterBucket)).map(requestRow)
    },

    forUser(userId) {
      return camelizeRows(selectByUser.all(userId)).map(requestRow)
    },

    /**
     * Open requests a business could answer: same category, same location, not
     * one it has already offered on. This is the marketplace's matchmaking query
     * and it is deliberately boring, because a surprising matcher is a matcher
     * nobody trusts.
     */
    matchingOpenRequests({ businessId, categoryId, locationId, limit = 25 }) {
      const page = normalisePagination({ limit, offset: 0 })
      const alreadyOffered = db.prepare(
        `SELECT request_id FROM request_offer WHERE business_id = ?`,
      )
      const offered = new Set(
        alreadyOffered.all(businessId).map((row) => row.request_id),
      )
      return camelizeRows(
        openRequestsMatchingBusiness.all(categoryId, locationId, page.limit),
      )
        .map(requestRow)
        .filter((request) => !offered.has(request.id))
    },

    offersForBusiness(businessId) {
      return camelizeRows(offersForBusiness.all(businessId))
    },

    addOffer(requestId, businessId, { message = null, price = null } = {}) {
      const request = requireRequest(requestId)
      if (request.status !== 'open' && request.status !== 'matched') {
        throw new ConflictError('This request is no longer accepting offers.', {
          status: request.status,
        })
      }
      if (selectOfferByBusiness.get(requestId, businessId)) {
        throw new ConflictError('This business has already offered on this request.', {
          requestId,
          businessId,
        })
      }
      const id = newId()
      const write = db.transaction(() => {
        insertOffer.run({
          id,
          requestId,
          businessId,
          message: message ? String(message).slice(0, 2000) : null,
          price: numberOrNull(price),
          status: 'submitted',
        })
        insertStatusEvent.run({
          id: newId(),
          requestId,
          fromStatus: request.status,
          toStatus: request.status,
          actorId: null,
          note: 'An offer was submitted.',
        })
      })
      write()
      return camelizeRow(selectOffer.get(id, requestId))
    },

    /**
     * Accepts an offer, which is the moment a request stops being demand and
     * becomes a transaction. Other offers are declined in the same transaction,
     * because a request with four accepted offers is not a matched request.
     */
    acceptOffer(offerId, { actorId = null, note = null } = {}) {
      const offer = db.prepare(`SELECT * FROM request_offer WHERE id = ?`).get(offerId)
      if (!offer) throw new NotFoundError('RequestOffer', offerId)
      if (offer.status !== 'submitted') {
        throw new ConflictError('That offer is no longer open.', { status: offer.status })
      }
      const request = requireRequest(offer.request_id)

      const write = db.transaction(() => {
        setOfferStatus.run({ id: offerId, status: 'accepted', now: nowIso() })
        declineOthers.run({ requestId: offer.request_id, offerId, now: nowIso() })
        setStatus.run({ id: request.id, status: 'in_progress', now: nowIso() })
        insertStatusEvent.run({
          id: newId(),
          requestId: request.id,
          fromStatus: request.status,
          toStatus: 'in_progress',
          actorId,
          note: note ?? 'An offer was accepted.',
        })
      })
      write()

      return repository.detail(request.id, { includePrivate: true })
    },

    setOfferStatus(offerId, status) {
      if (!['declined', 'withdrawn', 'completed'].includes(status)) {
        throw new ValidationError(`An offer cannot be moved to "${status}".`)
      }
      const offer = db.prepare(`SELECT * FROM request_offer WHERE id = ?`).get(offerId)
      if (!offer) throw new NotFoundError('RequestOffer', offerId)
      setOfferStatus.run({ id: offerId, status, now: nowIso() })
      return camelizeRow(
        db.prepare(`SELECT * FROM request_offer WHERE id = ?`).get(offerId),
      )
    },

    /**
     * Moves a request to a new status and records why.
     *
     * The status history is append-only and every transition writes an event, so
     * "how long did this take to match" is answerable from the request's own
     * record rather than estimated.
     */
    setStatus(requestId, status, { actorId = null, note = null } = {}) {
      const request = requireRequest(requestId)
      const next = assertRequestStatus(status)
      if (request.status === next) return repository.requireById(requestId)

      const write = db.transaction(() => {
        setStatus.run({ id: requestId, status: next, now: nowIso() })
        insertStatusEvent.run({
          id: newId(),
          requestId,
          fromStatus: request.status,
          toStatus: next,
          actorId,
          note,
        })
      })
      write()
      return repository.requireById(requestId)
    },

    markItemFilled(itemId) {
      const item = selectItem.get(itemId)
      if (!item) throw new NotFoundError('RequestItem', itemId)
      fillItem.run(itemId)
      return camelizeRow(selectItem.get(itemId))
    },

    /**
     * Expires requests whose window has passed.
     *
     * A stale open request is worse than a closed one: it inflates the count of
     * unmet demand in the gap engine, so an unexpired request is a signal and an
     * expired one has to actually be retired.
     */
    expireOverdue() {
      const overdue = expiringRequests.all(nowIso()).map((row) => row.id)
      if (overdue.length === 0) return 0
      const write = db.transaction(() => {
        for (const id of overdue) {
          const request = requireRequest(id)
          setStatus.run({ id, status: 'expired', now: nowIso() })
          insertStatusEvent.run({
            id: newId(),
            requestId: id,
            fromStatus: request.status,
            toStatus: 'expired',
            actorId: null,
            note: 'The request window closed.',
          })
        }
      })
      write()
      return overdue.length
    },

    /** Marketplace health, for the lab. */
    stats({ since }) {
      const byStatus = Object.fromEntries(
        db.prepare(`SELECT status, COUNT(*) AS total FROM request GROUP BY status`).all().map((row) => [
          row.status,
          row.total,
        ]),
      )
      const openByLocation = new Map(
        countOpenByLocation.all().map((row) => [row.location_id, row.total]),
      )
      const days = timeToFirstOffer.get(since)?.days ?? null
      return {
        since,
        byStatus,
        open: byStatus.open ?? 0,
        openByLocation: Object.fromEntries(openByLocation),
        // Median time to first offer, in days. Null means "not enough history
        // yet", which is different from zero and is reported as null.
        medianDaysToFirstOffer: days === null ? null : Math.round(days * 100) / 100,
      }
    },

    countByStatus() {
      return Object.fromEntries(
        countByStatus.all().map((row) => [row.status, row.total]),
      )
    },
  }

  return repository
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
