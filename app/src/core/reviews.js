import { ValidationError } from './errors.js'

/**
 * Reviews and ratings.
 *
 * The rules for what a review is made of, and the arithmetic that turns a page
 * of them into a rating. Kept pure and clock-free like the rest of `core/` so a
 * test can summarise a fixed set of reviews and read the same numbers the api
 * would.
 *
 * Two things are deliberately *not* here. There is no spam classifier and no
 * profanity filter: both would be a guess dressed as a rule, and the platform
 * already has a human decision in the path — nothing is public until a moderator
 * publishes it — so the honest place to catch a bad review is that decision, not
 * a list of words in a source file. And there is no stored average: the summary
 * is recomputed from the rows that exist right now, so a review that is later
 * rejected takes its rating out of the number with it.
 */

/** The scale. Five points, whole numbers, most-to-least. */
export const RATINGS = Object.freeze([1, 2, 3, 4, 5])

export const REVIEW_STATUSES = Object.freeze(['pending', 'published', 'rejected'])

/** The two things a moderator can decide, and the status each one sets. */
export const MODERATION_DECISIONS = Object.freeze({
  publish: 'published',
  reject: 'rejected',
})

export function isReviewStatus(status) {
  return REVIEW_STATUSES.includes(status)
}

/** A display name by which the author is shown, and nothing more. */
export const AUTHOR_NAME_MAX = 80
export const TITLE_MAX = 160
export const BODY_MAX = 2000
export const REASON_MAX = 500

/**
 * A rating is a whole number on the scale, or it is refused.
 *
 * Accepting "4.5" and rounding it would let a caller choose the average by
 * submitting a value nobody can see on the five-star control, so anything that
 * is not one of the five whole points is an error rather than a nearest match.
 */
export function buildRating(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || !RATINGS.includes(number)) {
    throw new ValidationError('A rating must be a whole number from 1 to 5.', {
      field: 'rating',
      allowed: RATINGS,
    })
  }
  return number
}

function cleanText(value, { field, max, required = false, min = 1 }) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required.`, { field })
    return null
  }
  const text = String(value).trim()
  if (!text) {
    if (required) throw new ValidationError(`${field} is required.`, { field })
    return null
  }
  if (text.length < min) {
    throw new ValidationError(`${field} must be at least ${min} characters.`, { field })
  }
  if (text.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters.`, { field })
  }
  return text
}

/**
 * A private address, checked only enough to be worth storing.
 *
 * This is not email validation — no such thing exists in a regular expression —
 * it is a guard against a stray word landing in the column. The address is never
 * published and never used to send anything automatically, so being strict here
 * would reject real addresses for no benefit.
 */
export function buildAuthorEmail(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value).trim()
  if (text.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(text)) {
    throw new ValidationError('That does not look like an email address.', { field: 'email' })
  }
  return text
}

/**
 * A whole review as submitted, normalised.
 *
 * A rating with no words is a legitimate review — "five stars, nothing more to
 * say" is a real thing a person means — so the body and the title are optional
 * and only the rating and the author's display name are required.
 */
export function buildReview(input = {}) {
  return {
    rating: buildRating(input.rating),
    title: cleanText(input.title, { field: 'title', max: TITLE_MAX }),
    body: cleanText(input.body, { field: 'body', max: BODY_MAX, min: 3 }),
    authorName: cleanText(input.authorName ?? input.author, {
      field: 'authorName',
      max: AUTHOR_NAME_MAX,
      required: true,
      min: 2,
    }),
    authorEmail: buildAuthorEmail(input.authorEmail ?? input.email),
  }
}

/**
 * A moderation decision, which is a status and a reason.
 *
 * The reason is required for the same reason a listing's review reason is: the
 * decision is permanent, and the sentence explaining it is the only part of it
 * anyone will read later. Refusing to publish without one is cheaper than
 * explaining a year from now why a review vanished with no note against it.
 */
export function buildModerationDecision({ decision, status, reason } = {}) {
  const requested = status ?? (decision ? MODERATION_DECISIONS[decision] : null)
  if (!requested || !['published', 'rejected'].includes(requested)) {
    throw new ValidationError('A decision must be to publish or to reject.', {
      field: 'status',
      allowed: ['published', 'rejected'],
    })
  }
  const note = cleanText(reason, { field: 'reason', max: REASON_MAX, required: true, min: 3 })
  return { status: requested, reason: note }
}

/**
 * The rating a page of reviews adds up to.
 *
 * `average` is null rather than 0 when there is nothing to average, because a
 * business nobody has rated has no rating — reporting 0 stars would say the
 * opposite of the truth. It is rounded to one decimal, which is the resolution
 * of the scale itself: 4.5 and 4.6 are distinguishable to a reader, 4.48 and
 * 4.51 are not.
 */
export function summarise(reviews = []) {
  const histogram = Object.fromEntries(RATINGS.map((star) => [star, 0]))
  let total = 0
  for (const review of reviews) {
    const rating = review?.rating
    if (!RATINGS.includes(rating)) continue
    histogram[rating] += 1
    total += rating
  }
  const count = reviews.filter((review) => RATINGS.includes(review?.rating)).length
  return {
    count,
    average: count === 0 ? null : Math.round((total / count) * 10) / 10,
    histogram,
  }
}

/**
 * The shape any caller without `business:read` is allowed to see.
 *
 * `authorEmail` and `moderationReason` are absent rather than nulled: a field
 * that is present and empty is one a client renders as "not given", and why a
 * review was rejected is a note to the operator, not a fact about the reviewer.
 * This lives in core so the api layer strips the private fields from a pure
 * function rather than reaching into the repository folder to do it, and so the
 * one place that decides what is private is next to the rules for the record.
 */
export function publicReview(row) {
  if (!row) return null
  const { authorEmail, moderationReason, businessName, businessSlug, ...rest } = row
  return rest
}
