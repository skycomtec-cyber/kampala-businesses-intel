import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { buildApi } from '../src/api/index.js'
import {
  RATINGS,
  REVIEW_STATUSES,
  buildRating,
  buildAuthorEmail,
  buildReview,
  buildModerationDecision,
  summarise,
  publicReview,
} from '../src/core/reviews.js'

/**
 * Reviews and ratings.
 *
 * The feature has one rule above all others — nothing a member of the public
 * writes is visible until a moderator publishes it — and most of these tests are
 * about that rule holding from every angle: a fresh submission is not on the
 * profile, a rejection removes a rating that was there, and the private email
 * never appears on a public payload. The arithmetic is checked separately
 * because it is the one part a reader can verify by eye.
 */

const PASSWORD = 'Kampala-Reference-2026'
const PROVIDER_PASSWORD = 'Provider-Self-Service-2026'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-reviews-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'reviews.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  return {
    app,
    server,
    config,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function signIn(ctx, { email, role = 'admin' }) {
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Reviews Editor', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

/** Creates a business and walks it to published, so it has a public profile. */
async function makePublished(ctx, headers, name = 'Bukoto Hardware') {
  const [district] = ctx.app.locations.byKind('district')
  const root = ctx.app.categories.ensureRoots()[1]
  const category = ctx.app.categories.children(root.id)[0]
  const created = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/admin/businesses',
    headers,
    payload: { name, categoryId: category.id, locationId: district.id, status: 'active' },
  })
  assert.equal(created.statusCode, 201, created.body)
  const id = created.json().data.id

  for (const action of ['verify', 'approve']) {
    const step = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${id}/verification`,
      headers,
      payload: { action, reason: 'Checked the shopfront on a site visit.' },
    })
    assert.equal(step.statusCode, 200, step.body)
  }
  return created.json().data
}

/** Grants a listing to a fresh provider account, the way the claim flow does. */
async function makeProvider(ctx, business, { email = 'owner@example.com' } = {}) {
  const claim = ctx.app.claims.create({
    businessId: business.id,
    claimedAs: 'Aisha Nakato',
    relation: 'owner',
    contactEmail: email,
  })
  const granted = ctx.app.claims.decide(claim.id, {
    decision: 'grant',
    reason: 'Matched the listing phone number on a call.',
  })
  const reset = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/password-reset/confirm',
    payload: { token: granted.passwordResetToken, newPassword: PROVIDER_PASSWORD },
  })
  assert.equal(reset.statusCode, 200, reset.body)
  const login = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PROVIDER_PASSWORD },
  })
  assert.equal(login.statusCode, 200, login.body)
  return { authorization: `Bearer ${login.json().data.token}` }
}

async function submitReview(ctx, slug, payload) {
  return ctx.server.inject({
    method: 'POST',
    url: `/api/v1/businesses/${slug}/reviews`,
    payload: { author: 'Nakato Grace', ...payload },
  })
}

async function decide(ctx, headers, reviewId, payload) {
  return ctx.server.inject({
    method: 'PATCH',
    url: `/api/v1/admin/reviews/${reviewId}`,
    headers,
    payload,
  })
}

/* --- the rules --------------------------------------------------------------- */

test('a review is a rating and a name; the words are optional', () => {
  assert.deepEqual(RATINGS, [1, 2, 3, 4, 5])
  assert.deepEqual(REVIEW_STATUSES, ['pending', 'published', 'rejected'])

  const bare = buildReview({ rating: 5, author: 'Ada' })
  assert.equal(bare.rating, 5)
  assert.equal(bare.authorName, 'Ada')
  assert.equal(bare.title, null)
  assert.equal(bare.body, null)
  assert.equal(bare.authorEmail, null)

  // 4.5 would let a caller pick a value nobody can see on a five-star control.
  assert.throws(() => buildRating(4.5), /whole number from 1 to 5/)
  assert.throws(() => buildRating('9'), /whole number from 1 to 5/)
  assert.throws(() => buildReview({ rating: 3 }), /authorName is required/)
  assert.throws(() => buildReview({ rating: 3, author: 'A' }), /at least 2 characters/)

  // An email is optional and only guarded against a stray word, not validated.
  assert.equal(buildAuthorEmail(''), null)
  assert.throws(() => buildAuthorEmail('not an address'), /email address/)
})

test('a decision is to publish or to reject, and always says why', () => {
  assert.equal(buildModerationDecision({ decision: 'publish', reason: 'Looks genuine.' }).status, 'published')
  assert.equal(buildModerationDecision({ status: 'rejected', reason: 'Advertising.' }).status, 'rejected')
  assert.throws(() => buildModerationDecision({ decision: 'publish' }), /reason is required/)
  assert.throws(() => buildModerationDecision({ decision: 'feature', reason: 'Nice.' }), /publish or to reject/)
})

test('the average is over whole ratings, rounded to one decimal, and null when empty', () => {
  const empty = summarise([])
  assert.equal(empty.count, 0)
  assert.equal(empty.average, null)
  assert.deepEqual(empty.histogram, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })

  const summary = summarise([{ rating: 5 }, { rating: 4 }, { rating: 5 }])
  assert.equal(summary.count, 3)
  assert.equal(summary.average, 4.7)
  assert.deepEqual(summary.histogram, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 })

  // Rows that are not on the scale are ignored rather than dragging the number.
  assert.equal(summarise([{ rating: 5 }, { rating: 9 }, {}]).count, 1)
})

test('the public shape drops the email and the moderator note', () => {
  const public_ = publicReview({
    id: 'r1',
    rating: 5,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    moderationReason: 'Looked genuine.',
    businessName: 'Bukoto Hardware',
    businessSlug: 'bukoto-hardware',
  })
  assert.deepEqual(public_, { id: 'r1', rating: 5, authorName: 'Ada' })
  assert.equal(publicReview(null), null)
})

/* --- the flow ---------------------------------------------------------------- */

test('a submission is held for moderation, and only appears once published', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)

    // Before anything, the business has no rating — not zero.
    const before = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}` })
    assert.deepEqual(before.json().data.rating, { count: 0, average: null, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } })

    const submitted = await submitReview(ctx, business.slug, {
      rating: 5,
      title: 'Fixed my phone same day',
      body: 'Walked in with a cracked screen and walked out working.',
      email: 'grace@example.com',
    })
    assert.equal(submitted.statusCode, 201, submitted.body)
    const created = submitted.json().data
    assert.equal(created.status, 'pending')
    assert.equal(submitted.json().meta.moderation, 'pending')
    // The private address is nowhere on the payload that comes back.
    assert.equal('authorEmail' in created, false)
    assert.equal('moderationReason' in created, false)

    // Pending, so nothing is public yet.
    const list = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}/reviews` })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().meta.total, 0)
    assert.equal(list.json().meta.rating.count, 0)
    assert.deepEqual(list.json().data, [])

    // The moderator sees it, email and all, because deciding needs the evidence.
    const queue = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/reviews?status=pending', headers: admin })
    assert.equal(queue.statusCode, 200, queue.body)
    const held = queue.json().data.find((row) => row.id === created.id)
    assert.ok(held, 'the pending review is in the queue')
    assert.equal(held.authorEmail, 'grace@example.com')
    assert.equal(held.businessSlug, business.slug)

    const published = await decide(ctx, admin, created.id, { decision: 'publish', reason: 'Looks like a real visit.' })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().data.status, 'published')

    // Now it is on the profile, on the list, and counted, and the email is gone.
    const after = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}` })
    assert.equal(after.json().data.rating.count, 1)
    assert.equal(after.json().data.rating.average, 5)

    const publicList = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}/reviews` })
    assert.equal(publicList.json().meta.total, 1)
    const shown = publicList.json().data[0]
    assert.equal(shown.authorName, 'Nakato Grace')
    assert.equal('authorEmail' in shown, false)
    assert.equal('moderationReason' in shown, false)

    const directory = await ctx.server.inject({ method: 'GET', url: '/api/v1/businesses' })
    const card = directory.json().data.find((row) => row.id === business.id)
    assert.equal(card.rating.count, 1)
    assert.equal(card.rating.average, 5)
  } finally {
    await ctx.cleanup()
  }
})

test('a rejection takes the rating back out, and a decision without a reason is refused', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)

    const five = await submitReview(ctx, business.slug, { rating: 5 })
    const three = await submitReview(ctx, business.slug, { rating: 3 })
    const fiveId = five.json().data.id
    const threeId = three.json().data.id

    await decide(ctx, admin, fiveId, { decision: 'publish', reason: 'Genuine.' })
    await decide(ctx, admin, threeId, { decision: 'publish', reason: 'Genuine too.' })

    let profile = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}` })
    assert.equal(profile.json().data.rating.count, 2)
    assert.equal(profile.json().data.rating.average, 4)

    // Rejecting the three topples the average the moment it is decided — there is
    // no stored rollup to recompute, so there is nothing that can go stale.
    const rejected = await decide(ctx, admin, threeId, { decision: 'reject', reason: 'Actually a rival shop.' })
    assert.equal(rejected.statusCode, 200, rejected.body)
    assert.equal(rejected.json().data.status, 'rejected')
    assert.equal(rejected.json().data.moderationReason, 'Actually a rival shop.')

    profile = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}` })
    assert.equal(profile.json().data.rating.count, 1)
    assert.equal(profile.json().data.rating.average, 5)

    // The reason is not decoration: a decision without one is a 400.
    const noReason = await decide(ctx, admin, fiveId, { decision: 'reject' })
    assert.equal(noReason.statusCode, 400, noReason.body)

    // A rejection is not a deletion: the row is still there for the moderator.
    const queue = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/reviews?status=rejected', headers: admin })
    assert.equal(queue.json().data.some((row) => row.id === threeId), true)

    const removed = await ctx.server.inject({
      method: 'DELETE',
      url: `/api/v1/admin/reviews/${threeId}`,
      headers: admin,
    })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.equal(removed.json().data.removed, true)
  } finally {
    await ctx.cleanup()
  }
})

test('the owner sees their own reviews, but not somebody else\'s listing', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)

    const other = await makePublished(ctx, admin, 'Elsewhere Enterprises')
    const otherProvider = await makeProvider(ctx, other, { email: 'other@example.com' })

    await submitReview(ctx, business.slug, { rating: 4, body: 'Good work and fair prices.' })

    const mine = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${business.id}/reviews`,
      headers: provider,
    })
    assert.equal(mine.statusCode, 200, mine.body)
    // The owner sees the pending one, so they are not blindsided by it later.
    assert.equal(mine.json().meta.total, 1)
    assert.equal(mine.json().data[0].status, 'pending')
    assert.equal('authorEmail' in mine.json().data[0], false)

    const intrude = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${business.id}/reviews`,
      headers: otherProvider,
    })
    assert.equal(intrude.statusCode, 403, intrude.body)

    // An admin is not a provider, and no account is not a desk.
    const adminAtDesk = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${business.id}/reviews`,
      headers: admin,
    })
    assert.equal(adminAtDesk.statusCode, 403, adminAtDesk.body)

    const anonymous = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${business.id}/reviews`,
    })
    assert.equal(anonymous.statusCode, 401, anonymous.body)
  } finally {
    await ctx.cleanup()
  }
})

test('a listing that is not public cannot be reviewed, and cannot be found', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const [district] = ctx.app.locations.byKind('district')
    const root = ctx.app.categories.ensureRoots()[1]
    const category = ctx.app.categories.children(root.id)[0]
    const draft = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/businesses',
      headers: admin,
      payload: { name: 'Not Yet Listed', categoryId: category.id, locationId: district.id, status: 'active' },
    })
    const draftSlug = draft.json().data.slug

    const onDraft = await submitReview(ctx, draftSlug, { rating: 5 })
    assert.equal(onDraft.statusCode, 404, onDraft.body)

    const onUnknown = await submitReview(ctx, 'no-such-business', { rating: 5 })
    assert.equal(onUnknown.statusCode, 404, onUnknown.body)

    // The schema refuses a rating off the scale before it reaches the database.
    const publicBusiness = await makePublished(ctx, admin)
    const badRating = await submitReview(ctx, publicBusiness.slug, { rating: 9 })
    assert.equal(badRating.statusCode, 400, badRating.body)
    const noAuthor = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/businesses/${publicBusiness.slug}/reviews`,
      payload: { rating: 5 },
    })
    assert.equal(noAuthor.statusCode, 400, noAuthor.body)
  } finally {
    await ctx.cleanup()
  }
})

test('review submissions are rate limited, so one address cannot flood the queue', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)

    for (let i = 0; i < 5; i += 1) {
      const response = await submitReview(ctx, business.slug, { rating: 5, author: `Caller ${i}` })
      assert.equal(response.statusCode, 201, response.body)
    }

    const blocked = await submitReview(ctx, business.slug, { rating: 5, author: 'One Too Many' })
    assert.equal(blocked.statusCode, 429, blocked.body)
    assert.equal(Number(blocked.headers['x-ratelimit-limit']), 5)
  } finally {
    await ctx.cleanup()
  }
})
