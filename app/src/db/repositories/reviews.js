import { newId } from '../../core/identifiers.js'
import { buildReview, buildModerationDecision, summarise } from '../../core/reviews.js'
import { NotFoundError } from '../../core/errors.js'
import { camelizeRow, nowIso } from '../mapping.js'
import { normalisePagination, where, resolveOrder } from './common.js'

/**
 * Business reviews.
 *
 * The first content in the platform written by the public, and the repository is
 * shaped by that one fact. A submission is always created `pending`; there is no
 * argument to `create` that makes it public, because a signature flag would be a
 * second way to publish and the only way to publish should be to record a
 * decision. `moderate` is that decision, and it is the only method that can move
 * a review into or out of `published`.
 *
 * `author_email` is stored and never selected by anything that answers a public
 * caller. The public shape is produced by `publicReview`, which drops it, so a
 * route cannot leak it by forgetting to filter — it would have to go out of its
 * way to call the wrong mapper.
 *
 * The rating a business shows is never stored. `summarise` is applied to the
 * published rows at read time, so rejecting a review removes its stars from the
 * average in the same moment, with no rollup to recompute and none to go stale.
 */

const REVIEW_COLUMNS = `
  r.id, r.business_id, r.rating, r.title, r.body, r.author_name, r.author_email,
  r.status, r.source, r.reviewer_id, r.moderation_reason, r.moderated_at,
  r.created_at, r.updated_at
`

const REVIEW_JOIN = `
  FROM business_review r
  JOIN business b ON b.id = r.business_id
`

const ADMIN_REVIEW_COLUMNS = `${REVIEW_COLUMNS}, b.name AS business_name, b.slug AS business_slug`

const LIST_SORTS = Object.freeze({
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
  rating: 'r.rating DESC',
})

export function createReviewsRepository(db) {
  const insert = db.prepare(
    `INSERT INTO business_review (
       id, business_id, rating, title, body, author_name, author_email, status, source
     ) VALUES (
       @id, @businessId, @rating, @title, @body, @authorName, @authorEmail, @status, @source
     )`,
  )
  const selectById = db.prepare(`SELECT ${REVIEW_COLUMNS} FROM business_review r WHERE r.id = ?`)
  const selectAdminById = db.prepare(
    `SELECT ${ADMIN_REVIEW_COLUMNS} ${REVIEW_JOIN} WHERE r.id = ?`,
  )
  const updateDecision = db.prepare(
    `UPDATE business_review
        SET status = @status,
            reviewer_id = @reviewerId,
            moderation_reason = @reason,
            moderated_at = @moderatedAt,
            updated_at = @now
      WHERE id = @id`,
  )
  const deleteById = db.prepare('DELETE FROM business_review WHERE id = ?')
  const selectRatingsForBusiness = db.prepare(
    `SELECT rating FROM business_review WHERE business_id = ? AND status = 'published'`,
  )
  const selectPublishedRatingsForMany = db.prepare(
    `SELECT business_id, rating FROM business_review WHERE status = 'published'`,
  )
  const countByStatus = db.prepare(
    `SELECT status, COUNT(*) AS total FROM business_review GROUP BY status`,
  )

  function requireReview(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Review', id)
    return camelizeRow(row)
  }

  /** Shared paging over the joined view, used by both list surfaces. */
  function page({ businessId = null, status = null, sort = 'newest', limit, offset }, { admin }) {
    const parsed = normalisePagination({ limit, offset })
    const conditions = []
    const params = { limit: parsed.limit, offset: parsed.offset }
    if (businessId) {
      conditions.push('r.business_id = @businessId')
      params.businessId = businessId
    }
    if (status) {
      conditions.push('r.status = @status')
      params.status = status
    }
    const clause = where(conditions)
    const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)
    const columns = admin ? ADMIN_REVIEW_COLUMNS : REVIEW_COLUMNS
    const rows = db
      .prepare(
        `SELECT ${columns} ${REVIEW_JOIN} ${clause}
          ORDER BY ${order}, r.id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all(params)
    const total = db.prepare(`SELECT COUNT(*) AS total ${REVIEW_JOIN} ${clause}`).get(params).total
    return { items: rows.map(camelizeRow), total }
  }

  return {
    /**
     * Records a submission. Always `pending`; the caller cannot choose otherwise.
     *
     * The whole review is validated in `core/reviews.js` first, so a rating of 9
     * or a missing author is refused here with a sentence rather than reaching the
     * schema's CHECK and coming back as a 500.
     */
    create({ businessId, source = 'web', ...input }) {
      const review = buildReview(input)
      const id = newId()
      insert.run({
        id,
        businessId,
        rating: review.rating,
        title: review.title,
        body: review.body,
        authorName: review.authorName,
        authorEmail: review.authorEmail,
        status: 'pending',
        source,
      })
      return requireReview(id)
    },

    /** The full row, for a moderator. Throws when it does not exist. */
    requireById(id) {
      return requireReview(id)
    },

    /** The moderation view of one review, with the business it belongs to. */
    adminById(id) {
      const row = selectAdminById.get(id)
      if (!row) throw new NotFoundError('Review', id)
      return camelizeRow(row)
    },

    /** A business's published reviews, for the public profile. */
    listPublished({ businessId, limit, offset, sort }) {
      return page({ businessId, status: 'published', sort, limit, offset }, { admin: false })
    },

    /** Everything, for the moderation queue, newest business activity first. */
    list({ businessId, status, sort, limit, offset }) {
      return page({ businessId, status, sort, limit, offset }, { admin: true })
    },

    /**
     * The decision that is the only way in or out of the public view.
     *
     * A decision is idempotent in effect — publishing an already-published review
     * writes the same status again — but the trail is rewritten each time, so the
     * most recent judgement and its reason are always the ones on the row.
     */
    moderate(id, { status, decision, reason, reviewerId }) {
      const decisionValue = buildModerationDecision({ status, decision, reason })
      requireReview(id)
      updateDecision.run({
        id,
        status: decisionValue.status,
        reviewerId: reviewerId ?? null,
        reason: decisionValue.reason,
        moderatedAt: nowIso(),
        now: nowIso(),
      })
      return requireReview(id)
    },

    /** Deletes a review outright. Used for spam that is not worth keeping. */
    remove(id) {
      requireReview(id)
      return deleteById.run(id).changes > 0
    },

    /**
     * The rating summary for one business, computed from published rows only.
     *
     * `summarise` is handed the raw ratings, so the average and the histogram
     * come from the same rule the api answers with and cannot disagree.
     */
    summaryFor(businessId) {
      return summarise(selectRatingsForBusiness.all(businessId))
    },

    /**
     * Rating summaries for many businesses at once, for a directory page.
     *
     * One query for the whole page rather than one per card: the directory can
     * show a hundred listings, and a summary per row would be a hundred queries
     * for numbers that are cheap to gather together. A business with no reviews
     * is absent from the map, and the route reads that as "no rating".
     */
    summariesFor(businessIds = []) {
      const unique = [...new Set(businessIds.filter(Boolean))]
      if (unique.length === 0) return new Map()
      const placeholders = unique.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT business_id, rating FROM business_review
            WHERE status = 'published' AND business_id IN (${placeholders})`,
        )
        .all(unique)
      const grouped = new Map(unique.map((id) => [id, []]))
      for (const row of rows) grouped.get(row.business_id).push(row)
      const summaries = new Map()
      for (const [id, ratings] of grouped) summaries.set(id, summarise(ratings))
      return summaries
    },

    counts() {
      return Object.fromEntries(countByStatus.all().map((row) => [row.status, row.total]))
    },
  }
}
