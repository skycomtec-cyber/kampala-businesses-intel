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
  CLAIM_STATUSES,
  DECISIONS,
  DECISION_NAMES,
  legalDecisions,
  canDecide,
  assertDecisionForStatus,
  normaliseClaimContact,
  buildClaim,
} from '../src/core/claims.js'

/**
 * Provider self-service.
 *
 * A claim is the only door through which a member of the public becomes an
 * account holder, so the tests here are mostly about the shape of that door: it
 * opens once and to one claimant, the claimant can prove it is theirs without an
 * account, an operator decides, and only the decision creates the account and
 * hands over the listing.
 *
 * The pure rules are asserted against `core/claims.js` directly; the flow is
 * exercised through the api, because a transition rule that only holds when a
 * repository forgets to enforce it is not a rule.
 */

const PASSWORD = 'Kampala-Reference-2026'

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-claims-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'claims.db') })
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
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Claim Reviewer', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

async function makeBusiness(ctx, headers, name = 'Kibuli Phone Repair') {
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
  return created.json().data
}

async function submitClaim(ctx, payload) {
  return ctx.server.inject({ method: 'POST', url: '/api/v1/claims', payload })
}

/* --- the rules --------------------------------------------------------------- */

test('the claim lifecycle is one-way, and a grant is the only way in', () => {
  assert.deepEqual(CLAIM_STATUSES, ['pending', 'granted', 'withdrawn', 'rejected', 'revoked'])
  assert.deepEqual(DECISION_NAMES, ['grant', 'reject', 'revoke'])
  assert.equal(DECISIONS.grant, 'granted')

  assert.deepEqual(legalDecisions('pending'), ['grant', 'reject'])
  assert.deepEqual(legalDecisions('granted'), ['revoke'])
  assert.deepEqual(legalDecisions('withdrawn'), [])
  assert.deepEqual(legalDecisions('rejected'), [])

  assert.equal(canDecide('pending', 'grant'), true)
  assert.equal(canDecide('pending', 'revoke'), false)
  assert.equal(canDecide('granted', 'grant'), false)

  // A rejected claim is settled; the way back in is a fresh claim, not a
  // resurrection. A conflict (409) rather than a malformed request (400).
  assert.throws(() => assertDecisionForStatus('rejected', 'grant'), /cannot be/)
})

test('a claim has to name a business, a person and a relation', () => {
  assert.throws(() => buildClaim({ claimedAs: 'A', relation: 'owner' }), /name the business/)
  assert.throws(() => buildClaim({ businessId: 'b', claimedAs: 'A', relation: 'owner' }), /2 to 160/)
  assert.throws(() => buildClaim({ businessId: 'b', claimedAs: 'Aisha', relation: '' }), /relation/)

  const built = buildClaim({
    businessId: 'b',
    claimedAs: '  Aisha Nakato  ',
    relation: '  owner  ',
    contactEmail: '  AISHA@Example.COM ',
    contactPhone: '0772 123 456',
  })
  assert.equal(built.claimedAs, 'Aisha Nakato')
  assert.equal(built.relation, 'owner')
  assert.equal(built.contactEmail, 'aisha@example.com')
  // The same normalisation the contact points use, so the two compare when the
  // repository checks whether the claim corroborates the listing.
  assert.equal(built.contactPhone, '+256772123456')
  assert.equal(built.status, 'pending')
})

test('a claim contact is normalised, or refused', () => {
  assert.equal(normaliseClaimContact('email', ''), null)
  assert.equal(normaliseClaimContact('phone', '   '), null)
  assert.equal(normaliseClaimContact('email', 'Owner@Example.COM'), 'owner@example.com')
  // The same shape a contact point stores, so the two compare.
  assert.equal(normaliseClaimContact('phone', '0772 123 456'), '+256772123456')
  assert.throws(() => normaliseClaimContact('email', 'not-an-email'), /valid email/)
  assert.throws(() => normaliseClaimContact('phone', 'not a phone'), /valid Ugandan phone/)
})

/* --- the flow ---------------------------------------------------------------- */

test('a member of the public claims a listing, follows it, and withdraws it', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makeBusiness(ctx, admin)
    // A contact already on the listing, so the claim corroborates itself.
    const contact = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/businesses/${business.id}/contacts`,
      headers: admin,
      payload: { kind: 'phone', value: '0772 123 456', isPublic: true },
    })
    assert.equal(contact.statusCode, 201, contact.body)

    const submitted = await submitClaim(ctx, {
      businessId: business.id,
      claimedAs: 'Aisha Nakato',
      relation: 'owner',
      contactEmail: 'aisha@example.com',
      contactPhone: '0772123456',
    })
    assert.equal(submitted.statusCode, 201, submitted.body)
    const { reference, accessToken } = submitted.json().data
    assert.match(reference, /^CLM-\d{4}-\d{5}$/)
    assert.ok(accessToken && accessToken.length >= 16)

    // Public view: the reference resolves, but the claimant's own evidence does
    // not leak without proof.
    const publicView = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/claims/${reference}`,
    })
    assert.equal(publicView.statusCode, 200, publicView.body)
    assert.equal(publicView.json().data.status, 'pending')
    assert.equal(publicView.json().data.contactEmail, undefined)

    const privateView = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/claims/${reference}`,
      headers: { 'x-claim-token': accessToken },
    })
    assert.equal(privateView.statusCode, 200, privateView.body)
    assert.equal(privateView.json().data.contactEmail, 'aisha@example.com')
    assert.equal(privateView.json().data.matchesContact, true)

    // A second claim for the same listing is refused: one open claim at a time.
    const again = await submitClaim(ctx, {
      businessId: business.id,
      claimedAs: 'Somebody Else',
      relation: 'manager',
      contactEmail: 'someone@example.com',
    })
    assert.equal(again.statusCode, 409, again.body)

    const status = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/claims/status/${business.id}`,
    })
    assert.equal(status.json().data.claimable, false)
    assert.equal(status.json().data.claimed, false)

    // Withdraw with the token, then a second withdraw is a conflict.
    const withdrawn = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/claims/${reference}/withdraw`,
      payload: { accessToken },
    })
    assert.equal(withdrawn.statusCode, 200, withdrawn.body)
    assert.equal(withdrawn.json().data.status, 'withdrawn')

    const rewithdraw = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/claims/${reference}/withdraw`,
      payload: { accessToken },
    })
    assert.equal(rewithdraw.statusCode, 409, rewithdraw.body)

    // With the claim gone, the listing is open again.
    const reopened = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/claims/status/${business.id}`,
    })
    assert.equal(reopened.json().data.claimable, true)
  } finally {
    await ctx.cleanup()
  }
})

test('a claim cannot be granted without an email, and a rejection needs a reason', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'reviewer@kip.test' })
    const business = await makeBusiness(ctx, admin, 'Nakawa Repairs')

    const submitted = await submitClaim(ctx, {
      businessId: business.id,
      claimedAs: 'Moses Okello',
      relation: 'manager',
      contactPhone: '0772123456',
    })
    assert.equal(submitted.statusCode, 201, submitted.body)

    const list = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/admin/claims?status=pending',
      headers: admin,
    })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().data.length, 1)
    const claimId = list.json().data[0].id

    // No contact email, so there is nowhere to deliver the account a grant would
    // create. The operator has to ask for one first.
    const grant = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claimId}/decide`,
      headers: admin,
      payload: { decision: 'grant' },
    })
    assert.equal(grant.statusCode, 400, grant.body)

    const rejectNoReason = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claimId}/decide`,
      headers: admin,
      payload: { decision: 'reject' },
    })
    assert.equal(rejectNoReason.statusCode, 400, rejectNoReason.body)

    const reject = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claimId}/decide`,
      headers: admin,
      payload: { decision: 'reject', reason: 'Could not reach the claimant to confirm.' },
    })
    assert.equal(reject.statusCode, 200, reject.body)
    assert.equal(reject.json().data.claim.status, 'rejected')
  } finally {
    await ctx.cleanup()
  }
})

test('granting a claim creates a provider account and hands over the listing', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makeBusiness(ctx, admin)
    const other = await makeBusiness(ctx, admin, 'Elsewhere Enterprises')

    const submitted = await submitClaim(ctx, {
      businessId: business.id,
      claimedAs: 'Aisha Nakato',
      relation: 'owner',
      contactEmail: 'aisha@example.com',
    })
    assert.equal(submitted.statusCode, 201, submitted.body)

    const list = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/admin/claims?status=pending',
      headers: admin,
    })
    const claim = list.json().data[0]

    const decided = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claim.id}/decide`,
      headers: admin,
      payload: { decision: 'grant', reason: 'Matched the listing phone number on a call.' },
    })
    assert.equal(decided.statusCode, 200, decided.body)
    const result = decided.json().data
    assert.equal(result.claim.status, 'granted')
    assert.equal(result.owner.role, 'provider')
    assert.ok(result.passwordResetToken, 'a grant hands back a one-time delivery token')

    // The listing is now marked as claimed, because it was unverified before.
    assert.equal(ctx.app.businesses.findById(business.id).capabilityLevel, 'claimed')

    // The owner signs in using the reset token, then reaches only their listing.
    const reset = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      payload: { token: result.passwordResetToken, newPassword: 'Provider-Self-Service-2026' },
    })
    assert.equal(reset.statusCode, 200, reset.body)

    const login = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'aisha@example.com', password: 'Provider-Self-Service-2026' },
    })
    assert.equal(login.statusCode, 200, login.body)
    const provider = { authorization: `Bearer ${login.json().data.token}` }

    const owned = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/provider/businesses',
      headers: provider,
    })
    assert.equal(owned.statusCode, 200, owned.body)
    assert.deepEqual(
      owned.json().data.map((row) => row.id),
      [business.id],
    )

    // The profile the owner sees includes the private contact points, which is
    // the difference between the provider route and the public one.
    const profile = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${business.id}`,
      headers: provider,
    })
    assert.equal(profile.statusCode, 200, profile.body)

    // Editing the words is allowed.
    const patched = await ctx.server.inject({
      method: 'PATCH',
      url: `/api/v1/provider/businesses/${business.id}`,
      headers: provider,
      payload: { description: 'Phone and laptop repairs, same day.', foundedYear: 2019 },
    })
    assert.equal(patched.statusCode, 200, patched.body)
    assert.equal(patched.json().data.description, 'Phone and laptop repairs, same day.')

    // Renaming the business is not: the schema refuses a field the desk does not
    // expose, rather than the route silently dropping it.
    const rename = await ctx.server.inject({
      method: 'PATCH',
      url: `/api/v1/provider/businesses/${business.id}`,
      headers: provider,
      payload: { name: 'Taken Over Ltd' },
    })
    assert.equal(rename.statusCode, 400, rename.body)

    // A second listing is somebody else's, and the ownership check says so.
    const intrude = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/provider/businesses/${other.id}`,
      headers: provider,
    })
    assert.equal(intrude.statusCode, 403, intrude.body)

    const addElsewhere = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/provider/businesses/${other.id}/contacts`,
      headers: provider,
      payload: { kind: 'phone', value: '0700000000' },
    })
    assert.equal(addElsewhere.statusCode, 403, addElsewhere.body)

    // A contact the owner adds is public, because hiding the owner's own number
    // from their own listing is the wrong default.
    const added = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/provider/businesses/${business.id}/contacts`,
      headers: provider,
      payload: { kind: 'phone', value: '0755123456' },
    })
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(added.json().data.isPublic, true)

    // Revoking takes the listing back and undoes the capability bump, but the
    // account remains (it may own other listings).
    const revoke = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claim.id}/decide`,
      headers: admin,
      payload: { decision: 'revoke', reason: 'Listing was sold to a new owner.' },
    })
    assert.equal(revoke.statusCode, 200, revoke.body)
    assert.equal(revoke.json().data.claim.status, 'revoked')
    assert.equal(ctx.app.businesses.findById(business.id).capabilityLevel, 'unverified')
  } finally {
    await ctx.cleanup()
  }
})

test('an editor may reject a claim but may not grant one, because a grant creates an account', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const editor = await signIn(ctx, { email: 'editor@kip.test', role: 'editor' })
    const business = await makeBusiness(ctx, admin)

    const submitted = await submitClaim(ctx, {
      businessId: business.id,
      claimedAs: 'Aisha Nakato',
      relation: 'owner',
      contactEmail: 'aisha@example.com',
    })
    assert.equal(submitted.statusCode, 201, submitted.body)

    const list = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/admin/claims?status=pending',
      headers: admin,
    })
    const claimId = list.json().data[0].id

    const grant = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claimId}/decide`,
      headers: editor,
      payload: { decision: 'grant' },
    })
    assert.equal(grant.statusCode, 403, grant.body)

    const reject = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/admin/claims/${claimId}/decide`,
      headers: editor,
      payload: { decision: 'reject', reason: 'Evidence did not match.' },
    })
    assert.equal(reject.statusCode, 200, reject.body)
  } finally {
    await ctx.cleanup()
  }
})
