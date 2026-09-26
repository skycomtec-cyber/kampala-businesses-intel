import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData, seedCatalogue } from '../src/seed/index.js'
import { REVIEW_STATES, REVIEW_ACTIONS, legalActions } from '../src/core/catalogue.js'
import { isPubliclyVisible } from '../src/core/business.js'

/**
 * The catalogue: where a record comes from, and how it earns the right to be
 * public.
 *
 * The list of tests in this file is the phase's acceptance list, one test per
 * promise, in the order the promises are made:
 *
 *   - a source can be created
 *   - an organization can be imported through it
 *   - the import lands in PENDING_REVIEW
 *   - the provenance relationship is stored
 *   - it can be reviewed, verified, approved and rejected
 *   - a record that is not approved cannot be returned by public search
 *   - a record that is approved is
 *
 * Everything here goes through the public repository surface rather than the
 * database, because the point being tested is that the *platform* cannot publish
 * an unreviewed record, not that a particular SQL statement has the right
 * keywords in it.
 */

function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-catalogue-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'test.db') })
  const app = openApp({ config })
  return {
    app,
    cleanup() {
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Reference data plus the one source the phase names, so each test states only
 * what it is actually about.
 */
function seeded() {
  const ctx = freshApp()
  seedReferenceData(ctx.app, { config: ctx.app.config ?? {} })
  return ctx
}

const MANUAL_SOURCE = {
  name: 'KampalaBiz Manual Import',
  type: 'manual',
  trustLevel: 'controlled',
  description: 'Organizations manually entered by an authorized KampalaBiz.Space administrator.',
}

/** The one real organization the phase asks for, with nothing invented. */
const SKYCOMTEC = {
  name: 'Skycomtec',
  description:
    'Computer and electronic equipment installation, repair and maintenance services in Kampala, Uganda.',
}

test('a source can be created, and its key is derived from its name', (t) => {
  const ctx = freshApp()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(MANUAL_SOURCE)
  assert.equal(source.name, 'KampalaBiz Manual Import')
  assert.equal(source.key, 'kampalabiz-manual-import')
  assert.equal(source.type, 'manual')
  assert.equal(source.trustLevel, 'controlled')
  assert.equal(source.isActive, true)
  assert.equal(source.recordCount, 0)

  // The same source created twice is the same source. An intake that could
  // create a second copy of "KampalaBiz Manual Import" would give every record
  // two possible origins and pick whichever it saw first, and the seed runs on
  // every start.
  const again = ctx.app.catalogue.createSource(MANUAL_SOURCE)
  assert.equal(again.id, source.id)
  assert.equal(
    ctx.app.catalogue.allSources().filter((row) => row.name === MANUAL_SOURCE.name).length,
    1,
  )

  // A source that is not a real kind of source, or that claims a trust level it
  // has not earned, is refused rather than stored and believed later.
  assert.throws(() => ctx.app.catalogue.createSource({ name: 'Rumours', type: 'hearsay' }), /Unknown source type/)
  assert.throws(
    () => ctx.app.catalogue.createSource({ name: 'Rumours', type: 'api', trustLevel: 'trusts-me' }),
    /Unknown trust level/,
  )
  assert.equal(ctx.app.catalogue.findSourceByKey('rumours'), null, 'neither refusal wrote a row')
})

test('an organization can be imported from a source, and lands in PENDING_REVIEW', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(MANUAL_SOURCE)
  const category = ctx.app.categories.all().find((row) => row.name === 'Device Repair')
  const location = ctx.app.locations.listByKind('district', { limit: 100 }).items
    .find((row) => row.name === 'Kampala District')

  const { business, claimedState } = ctx.app.catalogue.intake({
    sourceKey: source.key,
    record: { ...SKYCOMTEC, categoryId: category.id, locationId: location.id },
    externalRef: 'KB-MANUAL-0001',
    evidence: 'KampalaBiz.Space manual directory entry',
    queue: true,
  })

  assert.equal(business.name, 'Skycomtec')
  assert.equal(business.verificationState, 'pending_review')
  assert.equal(claimedState, null, 'a source cannot claim a review state it has no standing to claim')
  assert.equal(business.catalogueSourceId, source.id)

  // And it is in the queue, which is the whole point of arriving through a source.
  const queue = ctx.app.catalogue.queue({ state: 'pending_review' })
  assert.equal(queue.total, 1)
  assert.equal(queue.items[0].id, business.id)
  assert.equal(queue.items[0].sourceKey, source.key)
  assert.equal(queue.items[0].stateLabel, 'waiting for review')
  // The row carries the decisions the server would accept, so a queue view
  // cannot offer a button that is refused or hide one that is allowed.
  assert.ok(queue.items[0].availableActions.includes('verify'))
  assert.ok(queue.items[0].availableActions.includes('reject'))
  assert.equal(queue.items[0].availableActions.includes('approve'), false)

  // A record cannot be created into a state that means somebody checked it. A
  // caller arriving with `approved` is either confused or is somebody skipping
  // the queue, and both are what this phase exists to prevent.
  assert.throws(
    () =>
      ctx.app.businesses.create({
        name: 'Skipped The Queue',
        categoryId: category.id,
        locationId: location.id,
        status: 'active',
        verificationState: 'approved',
      }),
    /cannot be created as approved/,
  )
})

test('the provenance relationship between the organization and the source is stored', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const source = ctx.app.catalogue.createSource(MANUAL_SOURCE)
  const category = ctx.app.categories.all().find((row) => row.name === 'Device Repair')
  const location = ctx.app.locations.listByKind('district', { limit: 100 }).items
    .find((row) => row.name === 'Kampala District')

  const { business } = ctx.app.catalogue.intake({
    sourceKey: source.key,
    record: { ...SKYCOMTEC, categoryId: category.id, locationId: location.id },
    externalRef: 'KB-MANUAL-0001',
    batchRef: 'manual-2026-09',
    evidence: 'KampalaBiz.Space manual directory entry',
    queue: true,
  })

  const trail = ctx.app.catalogue.trail(business.id)
  assert.equal(trail.provenance.length, 1)
  assert.equal(trail.provenance[0].sourceKey, source.key)
  assert.equal(trail.provenance[0].sourceName, MANUAL_SOURCE.name)
  assert.equal(trail.provenance[0].externalRef, 'KB-MANUAL-0001')
  assert.equal(trail.provenance[0].batchRef, 'manual-2026-09')
  assert.equal(trail.provenance[0].evidence, 'KampalaBiz.Space manual directory entry')
  assert.equal(trail.source.id, source.id)

  // The intake itself is an event, with no "from", because there was no previous
  // state: this is how the record arrived, not how it moved.
  assert.equal(trail.events[0].action, 'import')
  assert.equal(trail.events[0].fromState, null)
  assert.equal(trail.events[0].toState, 'imported')

  // The source knows what it supplied, without a join the caller has to know to
  // make. A source whose counts are wrong is worse than one with no counts.
  assert.equal(ctx.app.catalogue.countsForSource(source.id).recordCount, 1)
  assert.equal(ctx.app.catalogue.countRecordsWithoutProvenance(), 0)

  // A retired source cannot supply anything new, but it does not lose the
  // records it already supplied: retiring a source stops the flow, it does not
  // rewrite history.
  ctx.app.catalogue.retireSource(source.id)
  assert.equal(ctx.app.catalogue.requireSourceByKey(source.key).isActive, false)
  assert.throws(
    () =>
      ctx.app.catalogue.intake({
        sourceKey: source.key,
        record: { ...SKYCOMTEC, categoryId: category.id, locationId: location.id },
      }),
    /is retired/,
  )
  assert.equal(ctx.app.catalogue.provenanceFor(business.id).length, 1)
})

test('the review can be claimed, verified, approved and un-approved, and every step is recorded', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const { business, source } = ingestSkycomtec(ctx)
  const actor = { id: null, role: 'editor' }

  const claimed = ctx.app.businesses.review(business.id, {
    action: 'claim',
    actor,
    reason: 'Picked up from the queue.',
  })
  assert.equal(claimed.verificationState, 'under_review')
  assert.notEqual(claimed.reviewClaimedAt, null)
  assert.equal(claimed.verifiedAt, null, 'claiming a record is not the same as checking it')
  assert.equal(claimed.approvedAt, null)

  const verified = ctx.app.businesses.review(business.id, {
    action: 'verify',
    actor,
    reason: 'Checked the services against the KampalaBiz listing.',
  })
  assert.equal(verified.verificationState, 'verified')
  assert.notEqual(verified.verifiedAt, null)
  assert.equal(verified.approvedAt, null, 'verified facts are not a decision to publish them')

  const approved = ctx.app.businesses.review(business.id, {
    action: 'approve',
    actor: { id: null, role: 'admin' },
    reason: 'Approved for the public directory.',
  })
  assert.equal(approved.verificationState, 'approved')
  assert.notEqual(approved.approvedAt, null)

  // The history is the record of who decided what, in order, with reasons. It is
  // the thing that has to be able to explain the listing later.
  const events = ctx.app.catalogue.eventsFor(business.id)
  assert.deepEqual(events.map((event) => event.action), [
    'import',
    'submit',
    'claim',
    'verify',
    'approve',
  ])
  assert.equal(events[3].reason, 'Checked the services against the KampalaBiz listing.')
  assert.equal(events[4].actorRole, 'admin')

  // Taking the approval back is a decision of its own, not an edit of the last
  // one, and the history keeps the approval that was there before it.
  const unapproved = ctx.app.businesses.review(business.id, {
    action: 'unapprove',
    actor: { id: null, role: 'admin' },
    reason: 'The source asked us to pause this listing.',
  })
  assert.equal(unapproved.verificationState, 'verified')
  assert.equal(ctx.app.catalogue.eventsFor(business.id).at(-1).action, 'unapprove')
  assert.equal(ctx.app.catalogue.eventsFor(business.id).length, 6)

  // A transition the pipeline does not have is refused, and refusing it writes
  // nothing: a queue full of refused attempts would be its own kind of noise.
  assert.throws(
    () => ctx.app.businesses.review(business.id, { action: 'obliterate', actor }),
    /Unknown review action/,
  )
  assert.equal(ctx.app.catalogue.eventsFor(business.id).length, 6)
  assert.equal(ctx.app.catalogue.provenanceFor(business.id)[0].sourceId, source.id)
})

test('a record can be rejected, and rejection is a decision that stops the listing', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const { business } = ingestSkycomtec(ctx)
  ctx.app.businesses.review(business.id, { action: 'claim', reason: 'Picked up.' })
  ctx.app.businesses.review(business.id, { action: 'verify', reason: 'Checked.' })

  const rejected = ctx.app.businesses.review(business.id, {
    action: 'reject',
    actor: { id: null, role: 'admin' },
    reason: 'It is a duplicate of an existing listing.',
  })
  assert.equal(rejected.verificationState, 'rejected')

  // A rejected record is not a dead end: it can go back to the queue. What it
  // cannot do is jump forward, because the rejection is the reason it is here.
  assert.throws(
    () => ctx.app.businesses.review(business.id, { action: 'approve', reason: 'Actually, fine.' }),
    /cannot be approve/,
  )
  const reopened = ctx.app.businesses.review(business.id, {
    action: 'reopen',
    reason: 'The duplicate was withdrawn.',
  })
  assert.equal(reopened.verificationState, 'pending_review')
  assert.deepEqual(
    ctx.app.catalogue.eventsFor(business.id).map((event) => event.action),
    ['import', 'submit', 'claim', 'verify', 'reject', 'reopen'],
  )
})

test('a record that is not approved cannot be returned by public search', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const { business, slug } = ingestSkycomtec(ctx)
  const query = 'electronic equipment repair'

  // Every state a record can be in before approval, checked one at a time, with
  // the same search each time. "Before approval" is not one moment, it is four.
  for (const step of [
    null,
    { action: 'claim', reason: 'Picked up.' },
    { action: 'verify', reason: 'Checked.' },
  ]) {
    if (step) ctx.app.businesses.review(business.id, step)
    const current = ctx.app.businesses.requireById(business.id)
    assert.equal(
      ctx.app.searchIndex.search({ query }).total,
      0,
      `not searchable in ${current.verificationState}`,
    )
    assert.equal(ctx.app.businesses.countPublished(), 0)
    assert.deepEqual(
      ctx.app.businesses.list({ publishedOnly: true }).items.map((row) => row.id),
      [],
    )
    // The predicate every public surface shares, asserted here so this file does
    // not depend on the api. `findBySlug` and `profile` still return the record:
    // they are the admin's read paths, and it is the route that decides what the
    // public is shown, which is what api.test.js covers.
    assert.equal(isPubliclyVisible(current), false, `not public in ${current.verificationState}`)
  }

  // The document is there, though. Keeping it is what makes re-approval a state
  // change rather than a re-import, and `is_active` is what keeps it out of
  // results.
  assert.equal(ctx.app.searchIndex.count({ publishedOnly: false }), 1)
})

test('a record that is approved is returned by public search, and rejected stops being returned', (t) => {
  const ctx = seeded()
  t.after(() => ctx.cleanup())

  const { business, slug } = ingestSkycomtec(ctx)
  const query = 'electronic equipment repair'
  const category = ctx.app.categories.all().find((row) => row.name === 'Device Repair')

  ctx.app.businesses.review(business.id, { action: 'claim', reason: 'Picked up.' })
  ctx.app.businesses.review(business.id, { action: 'verify', reason: 'Checked.' })
  ctx.app.businesses.review(business.id, { action: 'approve', reason: 'Published.' })

  // Indexed, findable, and countable by the public surfaces.
  const hits = ctx.app.searchIndex.search({ query })
  assert.equal(hits.total, 1)
  assert.equal(hits.items[0].docKey, `business:${business.id}`)
  assert.equal(hits.items[0].sourceType, 'business')
  assert.equal(ctx.app.searchIndex.count(), 1)
  assert.equal(ctx.app.businesses.countPublished(), 1)
  assert.equal(ctx.app.businesses.count({ status: 'active', categoryId: category.id }), 1)
  assert.equal(ctx.app.businesses.findBySlug(slug).verificationState, 'approved')
  assert.ok(ctx.app.businesses.profile(business.id, { includePrivateContacts: false }))
  assert.equal(isPubliclyVisible(ctx.app.businesses.requireById(business.id)), true)

  // Rejecting takes it back out, in the same transaction that records why.
  ctx.app.businesses.review(business.id, {
    action: 'reject',
    reason: 'It is a duplicate of an existing listing.',
  })
  assert.equal(ctx.app.searchIndex.search({ query }).total, 0)
  assert.equal(ctx.app.searchIndex.count(), 0)
  assert.equal(ctx.app.businesses.countPublished(), 0)
  assert.equal(isPubliclyVisible(ctx.app.businesses.requireById(business.id)), false)

  // And the history still explains it.
  assert.equal(ctx.app.catalogue.eventsFor(business.id).at(-1).action, 'reject')
})

test('every review state is accounted for, and the pipeline has no dead ends', () => {
  // A state nobody can leave is a state a record gets stuck in, and the only way
  // to find out is to notice a queue that never empties.
  for (const state of REVIEW_STATES) {
    const actions = legalActions(state)
    assert.ok(actions.length > 0, `${state} has no way out`)
    for (const action of actions) {
      assert.ok(REVIEW_ACTIONS[action], `${state} offers an action with no target: ${action}`)
    }
  }

  // `import` is the one action that cannot be performed on a record: there is no
  // way back to intake, because intake is how a record arrives.
  assert.equal(REVIEW_ACTIONS.import, 'imported')
  for (const state of REVIEW_STATES) {
    assert.equal(
      legalActions(state).includes('import'),
      false,
      `${state} must not offer a return to intake`,
    )
  }
})

/** Registers the manual source and brings Skycomtec in through it. */
function ingestSkycomtec(ctx) {
  const source = ctx.app.catalogue.createSource(MANUAL_SOURCE)
  const category = ctx.app.categories.all().find((row) => row.name === 'Device Repair')
  const location = ctx.app.locations
    .listByKind('district', { limit: 100 })
    .items.find((row) => row.name === 'Kampala District')
  const { business } = ctx.app.catalogue.intake({
    sourceKey: source.key,
    record: { ...SKYCOMTEC, categoryId: category.id, locationId: location.id },
    externalRef: 'KB-MANUAL-0001',
    evidence: 'KampalaBiz.Space manual directory entry',
    queue: true,
  })
  return { business, source, category, location, slug: business.slug }
}

test('the seeded demonstration record is real, sourced, and waiting for review', () => {
  const ctx = seeded()
  try {
    // The launcher seeds this before every start, so the first assertion is the
    // one that matters: a seed that ran twice has not created a second Skycomtec.
    const first = seedCatalogue(ctx.app)
    const second = seedCatalogue(ctx.app)
    assert.equal(first.created, true, first.reason ?? '')
    assert.equal(second.created, false)
    assert.equal(ctx.app.businesses.all().length, 1)

    const business = ctx.app.businesses.all()[0]
    assert.equal(business.name, SKYCOMTEC.name)
    assert.equal(business.verificationState, 'pending_review')
    // Active but unapproved: it is a live record that has not been published, which
    // is the only combination the approval gate is supposed to allow.
    assert.equal(isPubliclyVisible(business), false)
    assert.equal(ctx.app.searchIndex.count(), 0)
    assert.equal(ctx.app.businesses.countPublished(), 0)

    // Sourced, with the evidence attached, so a reviewer can see where it came from
    // without asking anybody.
    const trail = ctx.app.catalogue.trail(business.id)
    assert.equal(trail.provenance.length, 1)
    assert.equal(trail.provenance[0].sourceKey, 'kampalabiz-manual-import')
    assert.equal(trail.provenance[0].externalRef, 'KB-MANUAL-0001')
    assert.deepEqual(
      trail.events.map((event) => event.action),
      ['import', 'submit'],
    )

    // And nothing was invented. Phone numbers and email addresses are contact
    // points, not business fields, so "no contact points" is the honest form of
    // this claim: a demonstration record with a made-up number teaches a reviewer
    // to trust fields nobody checked, and one that rings a stranger is worse than
    // one that is missing.
    assert.deepEqual(ctx.app.businesses.contacts(business.id), [])
    assert.deepEqual(ctx.app.businesses.publicContacts(business.id), [])
    assert.equal(business.website, null)
    assert.equal(business.foundedYear, null)

    // Switched off, it writes nothing at all.
    const off = freshApp()
    try {
      const result = seedCatalogue(off.app, {
        config: { seed: { catalogueDemo: false } },
      })
      assert.deepEqual(result, { skipped: true, created: false, state: null, reason: null })
      assert.equal(off.app.businesses.all().length, 0)
    } finally {
      off.cleanup()
    }
  } finally {
    ctx.cleanup()
  }
})
