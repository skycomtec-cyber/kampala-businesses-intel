import { newId, slugify, disambiguateSlug, normaliseUrl } from '../../core/identifiers.js'
import {
  buildBusiness,
  buildContactPoint,
  canonicalContactValue,
  contactPointsLikelySameBusiness,
  isPubliclyVisible,
  supplyWeight,
  assertBusinessStatus,
  assertVerificationState,
  assertProductCondition,
  PHONE_KINDS,
} from '../../core/business.js'
import {
  reviewPlan,
  legalActions,
  actionFor,
  labelFor,
  assertIntakeState,
} from '../../core/catalogue.js'
import { assertCapabilityLevel } from '../../core/taxonomy.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso, toSqlBool, fromSqlBool } from '../mapping.js'
import { normalisePagination, where, likeParam, resolveOrder } from './common.js'

/**
 * Businesses and everything they offer.
 *
 * Three behaviours here are load-bearing for the rest of the platform:
 *
 *   1. Every write goes through core/business.js first, so no business can enter
 *      the database without a name, a category, a valid location and an explicit
 *      status. This layer trusts core; it does not re-validate.
 *   2. Every write re-indexes the affected search documents in the same
 *      transaction. The search index is not a background job that can fall
 *      behind, because a directory whose search results lag behind its own edits
 *      is a directory people stop trusting.
 *   3. A record's place in the review pipeline, the history of how it got there
 *      and its search visibility are one unit of work. `review` writes all three
 *      inside a single transaction, because a decision that is recorded but not
 *      indexed publishes a listing the public cannot find, and one that is indexed
 *      but not recorded cannot be explained to the business that was described.
 */

const BUSINESS_COLUMNS = `
  b.id, b.name, b.slug, b.description, b.category_id, b.primary_location_id,
  b.status, b.verification_state, b.capability_level, b.website, b.founded_year,
  b.source_id, b.catalogue_source_id, b.is_open_source, b.created_at, b.updated_at,
  b.verified_at, b.approved_at, b.review_owner_id, b.review_claimed_at,
  b.last_confirmed_at
`

const LIST_SORTS = Object.freeze({
  newest: 'b.created_at DESC',
  oldest: 'b.created_at ASC',
  updated: 'b.updated_at DESC',
  name: 'b.name ASC',
  'name desc': 'b.name DESC',
  status: 'b.status ASC',
  verification: 'b.verification_state ASC',
})

export function createBusinessesRepository(db, deps = {}) {
  const { searchIndex, skills, locations } = deps

  const insert = db.prepare(
    `INSERT INTO business (
       id, name, slug, description, category_id, primary_location_id, status,
       verification_state, capability_level, website, founded_year, source_id,
       catalogue_source_id, is_open_source
     ) VALUES (
       @id, @name, @slug, @description, @categoryId, @primaryLocationId, @status,
       @verificationState, @capabilityLevel, @website, @foundedYear, @sourceId,
       @catalogueSourceId, @isOpenSource
     )`,
  )
  const selectById = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b WHERE b.id = ?`,
  )
  const selectBySlug = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b WHERE b.slug = ?`,
  )
  // Name is compared case-insensitively inside one location, and only exactly.
  // This is the fallback for a row that carries no contact details at all, so
  // the bar has to be "the operator typed the same name for the same place".
  // Fuzzy matching here would quietly merge two real neighbours.
  const selectByName = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b
      WHERE b.primary_location_id = ? AND lower(b.name) = lower(?)
      LIMIT 1`,
  )
  const selectSlugExists = db.prepare(`SELECT 1 AS present FROM business WHERE slug = ?`)
  const selectAll = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b ORDER BY ${'b.created_at DESC'}`,
  )
  const selectByCategory = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b WHERE b.category_id = ?`,
  )
  // The published directory. `approved` and `active` are both required, and the
  // rule is written out here rather than left to a caller's memory of it, because
  // this is the query that decides what the public can see at all.
  const selectPublic = db.prepare(
    `SELECT ${BUSINESS_COLUMNS} FROM business b
      WHERE b.status = 'active' AND b.verification_state = 'approved'
      ORDER BY b.name ASC`,
  )
  const selectByContact = db.prepare(
    `SELECT b.id, b.name, b.slug FROM business b
       JOIN contact_point cp ON cp.business_id = b.id
      WHERE cp.kind = @kind AND cp.value = @value
      LIMIT 1`,
  )
  const updateRow = db.prepare(
    `UPDATE business
        SET name = @name,
            description = @description,
            category_id = @categoryId,
            primary_location_id = @primaryLocationId,
            status = @status,
            verification_state = @verificationState,
            capability_level = @capabilityLevel,
            website = @website,
            founded_year = @foundedYear,
            is_open_source = @isOpenSource,
            verified_at = @verifiedAt,
            last_confirmed_at = @lastConfirmedAt,
            updated_at = @now
      WHERE id = @id`,
  )
  const touchConfirmed = db.prepare(
    `UPDATE business SET last_confirmed_at = @now, updated_at = @now WHERE id = @id`,
  )

  /**
   * One step of the review pipeline, as a single statement.
   *
   * The CASE expressions are the interesting part, and they are written this way so
   * that the timestamps can never disagree with the state. A record that is not
   * `verified` has no `verified_at`, a record that is not `approved` has no
   * `approved_at`, and a record that is not `under_review` has no owner — not
   * because three separate branches were kept in step by hand, but because the
   * state column is the only input.
   *
   * A record reaching `approved` with no `verified_at` cannot happen through
   * review(), because approval is only reachable from `verified`. The COALESCE is
   * here so that a database edited outside the application still ends up with a
   * date for the decision that published it.
   */
  const applyReviewStep = db.prepare(
    `UPDATE business
        SET verification_state = @to,
            verified_at = CASE
              WHEN @to = 'verified' THEN @now
              WHEN @to = 'approved' THEN COALESCE(verified_at, @now)
              ELSE NULL
            END,
            approved_at = CASE WHEN @to = 'approved' THEN @now ELSE NULL END,
            review_owner_id = @ownerId,
            review_claimed_at = CASE WHEN @to = 'under_review' THEN @now ELSE NULL END,
            updated_at = @now
      WHERE id = @id`,
  )
  const insertReviewEvent = db.prepare(
    `INSERT INTO review_event (
       id, business_id, from_state, to_state, action,
       actor_id, actor_role, reason, source_id, created_at
     ) VALUES (
       @id, @businessId, @fromState, @toState, @action,
       @actorId, @actorRole, @reason, @sourceId, @createdAt
     )`,
  )

  // Secondary locations
  const insertLocation = db.prepare(
    `INSERT INTO business_location (
       id, business_id, location_id, address_text, latitude, longitude, is_primary
     ) VALUES (
       @id, @businessId, @locationId, @addressText, @latitude, @longitude, @isPrimary
     )`,
  )
  const selectLocations = db.prepare(
    `SELECT bl.id, bl.business_id, bl.location_id, bl.address_text, bl.latitude,
            bl.longitude, bl.is_primary, bl.created_at
       FROM business_location bl
       JOIN location l ON l.id = bl.location_id
      WHERE bl.business_id = ?
      ORDER BY bl.is_primary DESC, l.name ASC`,
  )
  const deleteLocation = db.prepare(`DELETE FROM business_location WHERE id = ?`)

  // Contacts
  const insertContact = db.prepare(
    `INSERT INTO contact_point (
       id, business_id, kind, value, is_primary, is_public
     ) VALUES (
       @id, @businessId, @kind, @value, @isPrimary, @isPublic
     )`,
  )
  const selectContacts = db.prepare(
    `SELECT id, business_id, kind, value, is_primary, is_public, created_at, updated_at
       FROM contact_point WHERE business_id = ? ORDER BY is_primary DESC, kind ASC`,
  )
  const selectContactsForBusinesses = db.prepare(
    `SELECT id, business_id, kind, value, is_primary, is_public
       FROM contact_point
      WHERE business_id IN (SELECT value FROM json_each(@ids))
      ORDER BY business_id, is_primary DESC, kind ASC`,
  )
  const selectPublicContacts = db.prepare(
    `SELECT id, business_id, kind, value, is_primary
       FROM contact_point WHERE business_id = ? AND is_public = 1
      ORDER BY is_primary DESC, kind ASC`,
  )
  const updateContact = db.prepare(
    `UPDATE contact_point
        SET is_public = @isPublic, is_primary = @isPrimary, updated_at = @now
      WHERE id = @id`,
  )
  const deleteContact = db.prepare(`DELETE FROM contact_point WHERE id = ?`)

  // Services and products
  const insertService = db.prepare(
    `INSERT INTO service (
       id, business_id, category_id, name, slug, description,
       price_min, price_max, price_unit
     ) VALUES (
       @id, @businessId, @categoryId, @name, @slug, @description,
       @priceMin, @priceMax, @priceUnit
     )`,
  )
  const selectService = db.prepare(`SELECT * FROM service WHERE id = ?`)
  // Two reads, on purpose. `selectServices` is what a profile shows, so it
  // excludes the retired ones. `selectEveryService` is what the indexer walks, so
  // it includes them: a service that has just been retired is no longer returned
  // by the first query, which means an indexer that only walked that query would
  // never get to flip its document to inactive, and the search results and the
  // profile would disagree about whether it exists.
  const selectServices = db.prepare(
    `SELECT * FROM service WHERE business_id = ? AND is_active = 1 ORDER BY name ASC`,
  )
  const selectEveryService = db.prepare(
    `SELECT * FROM service WHERE business_id = ? ORDER BY name ASC`,
  )
  const updateService = db.prepare(
    `UPDATE service
        SET name = @name, description = @description, category_id = @categoryId,
            price_min = @priceMin, price_max = @priceMax, price_unit = @priceUnit,
            is_active = @isActive, updated_at = @now
      WHERE id = @id`,
  )
  const deleteService = db.prepare(`DELETE FROM service WHERE id = ?`)

  const insertProduct = db.prepare(
    `INSERT INTO product (
       id, business_id, category_id, name, slug, description, condition,
       quantity, price_min, price_max, currency, is_recyclable, status
     ) VALUES (
       @id, @businessId, @categoryId, @name, @slug, @description, @condition,
       @quantity, @priceMin, @priceMax, @currency, @isRecyclable, @status
     )`,
  )
  const selectProduct = db.prepare(`SELECT * FROM product WHERE id = ?`)
  const selectProducts = db.prepare(
    `SELECT * FROM product WHERE business_id = ? ORDER BY created_at DESC`,
  )
  const updateProduct = db.prepare(
    `UPDATE product
        SET name = @name, description = @description, category_id = @categoryId,
            condition = @condition, quantity = @quantity,
            price_min = @priceMin, price_max = @priceMax, currency = @currency,
            is_recyclable = @isRecyclable, status = @status, updated_at = @now
      WHERE id = @id`,
  )
  const deleteProduct = db.prepare(`DELETE FROM product WHERE id = ?`)

  // Skills
  const insertSkill = db.prepare(
    `INSERT INTO business_skill (business_id, skill_id, proficiency, is_primary)
     VALUES (@businessId, @skillId, @proficiency, @isPrimary)
     ON CONFLICT(business_id, skill_id) DO UPDATE SET
       proficiency = excluded.proficiency,
       is_primary = excluded.is_primary`,
  )
  const selectSkills = db.prepare(
    `SELECT s.id, s.name, s.slug, bs.proficiency, bs.is_primary
       FROM business_skill bs
       JOIN skill s ON s.id = bs.skill_id
      WHERE bs.business_id = ?
      ORDER BY bs.is_primary DESC, bs.proficiency DESC, s.name ASC`,
  )
  const selectSkillIds = db.prepare(
    `SELECT skill_id FROM business_skill WHERE business_id = ?`,
  )
  const removeSkill = db.prepare(
    `DELETE FROM business_skill WHERE business_id = ? AND skill_id = ?`,
  )
  const linkServiceSkill = db.prepare(
    `INSERT OR IGNORE INTO service_skill (service_id, skill_id) VALUES (?, ?)`,
  )

  // How many businesses the public can actually see. Same predicate as
  // selectPublic, deliberately, so the count on a dashboard can never disagree
  // with the directory it is counting.
  const countPublished = db.prepare(
    `SELECT COUNT(*) AS total FROM business
      WHERE status = 'active' AND verification_state = 'approved'`,
  )
  // How many are waiting for a reviewer. Exposed because an operator needs to know
  // whether the queue is growing, and a directory that silently accumulates
  // unpublished records is a directory whose coverage claims are wrong.
  const countByReviewState = db.prepare(
    `SELECT verification_state, COUNT(*) AS total FROM business
      GROUP BY verification_state`,
  )
  const countByLocation = db.prepare(
    `SELECT COUNT(*) AS total FROM business
      WHERE primary_location_id = ? AND status = 'active' AND verification_state = 'approved'`,
  )
  // The supply count behind every "how much does Kampala actually have here?"
  // question, including the browse counters in the api.
  //
  // Both filters are optional and independent, and `includeSubtree` widens each
  // from an exact match to "anywhere at or below this node". The subtree form is
  // the one a person means by "in Wakiso district": almost no business is
  // registered against the district node itself, so an exact match would report
  // zero for a district full of workshops.
  //
  // `publishedOnly` is the public-facing rule and is on by default: a coverage
  // count that included records still sitting in the review queue would describe
  // a directory bigger than the one anybody can search. The gap engine does not
  // use this query, so nothing that needs unapproved evidence is affected.
  const countFiltered = db.prepare(
    `SELECT COUNT(*) AS total FROM business b
       JOIN location l ON l.id = b.primary_location_id
       JOIN category c ON c.id = b.category_id
      WHERE (@status IS NULL OR b.status = @status)
        AND (@publishedOnly = 0 OR b.verification_state = 'approved')
        AND (@categoryId IS NULL
             OR b.category_id = @categoryId
             OR (@includeSubtree = 1
                 AND ('/' || c.path_slugs || '/') LIKE
                     '%/' || (SELECT slug FROM category WHERE id = @categoryId) || '/%'))
        AND (@locationId IS NULL
             OR b.primary_location_id = @locationId
             OR (@includeSubtree = 1
                 AND ('/' || l.path_ids || '/') LIKE '%/' || @locationId || '/%'))`,
  )
  // Every record that could still be real, including the ones nobody has checked
  // yet. The gap engine reads these and weights them (see core/business.js), so the
  // filter here is "not already decided to be false" rather than "published": a
  // queue of checked-but-unapproved records is still evidence about where supply
  // is, while a rejected or archived record is a decision that it is not.
  const supplyRows = db.prepare(
    `SELECT id, status, verification_state, capability_level, primary_location_id
       FROM business
      WHERE status = 'active'
        AND verification_state NOT IN ('rejected', 'archived')`,
  )

  function requireBusiness(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Business', id)
    return row
  }

  /**
   * Finds a free slug.
   *
   * The loop lives here rather than in core because the uniqueness check needs
   * the data layer, while the suffix format is a core rule. Two businesses named
   * "Bright Future Bakery" therefore get `bright-future-bakery` and
   * `bright-future-bakery-2`, and any caller gets the same suffixes.
   */
  function resolveSlug(preferred) {
    const base = slugify(preferred)
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const candidate = disambiguateSlug(base, attempt)
      if (!selectSlugExists.get(candidate)) return candidate
    }
    // 200 collisions of the same name is a sign of a broken import, not a
    // naming problem, and a random suffix would hide it.
    throw new ConflictError('Could not find a free slug for this business.', { preferred })
  }

  function businessRow(row) {
    const record = camelizeRow(row)
    record.isOpenSource = fromSqlBool(record.isOpenSource)
    return record
  }

  /**
   * Gives a reviewer the contact evidence for a page of listings.
   *
   * A listing is reviewed on the strength of the details collected for it, so a
   * row that hides its phone number until the caller fetches it one at a time
   * turns a page of 25 listings into 26 requests and tells the reviewer nothing
   * about whether the row is even worth opening. One query for the whole page,
   * not one per row.
   *
   * Opt-in, and that is the privacy floor rather than a performance choice: this
   * list is also the public directory, the values here include contact points
   * that are unpublished on purpose, and a parameter a client can forget to send
   * is how a private phone number ends up in a public payload. Absent means
   * absent, so a caller cannot mistake an empty page for a page of listings with
   * no contact details.
   */
  function attachContactSummaries(items) {
    if (items.length === 0) return items
    const rows = selectContactsForBusinesses.all({ ids: JSON.stringify(items.map((item) => item.id)) })
    const byBusiness = new Map()
    for (const row of camelizeRows(rows)) {
      const contacts = byBusiness.get(row.businessId) ?? []
      contacts.push({
        ...row,
        isPrimary: fromSqlBool(row.isPrimary),
        isPublic: fromSqlBool(row.isPublic),
      })
      byBusiness.set(row.businessId, contacts)
    }
    for (const item of items) {
      const contacts = byBusiness.get(item.id) ?? []
      item.contacts = contacts
      // Whether this listing could be published at all: a verified listing with
      // no contact point is public but unreachable, which is worth seeing in the
      // queue rather than discovering in the directory.
      item.contactCount = contacts.length
      item.publicContactCount = contacts.filter((contact) => contact.isPublic).length
    }
    return items
  }

  function skillIdsFor(businessId) {
    return selectSkillIds.all(businessId).map((row) => row.skill_id)
  }

  /** The document a business contributes to the search index. */
  function businessDocument(business) {
    const location = locations ? locations.findById(business.primaryLocationId) : null
    return {
      docKey: `business:${business.id}`,
      sourceType: 'business',
      sourceId: business.id,
      title: business.name,
      name: business.name,
      path: `/business/${business.slug}`,
      body: [
        business.description,
        ...selectServices.all(business.id).map((service) => service.name),
      ]
        .filter(Boolean)
        .join('\n'),
      keywords: [
        ...selectSkills.all(business.id).map((skill) => skill.name),
        location ? location.name : null,
      ]
        .filter(Boolean)
        .map((keyword) => keyword.toLowerCase()),
      locationId: business.primaryLocationId,
      locationPathIds: location ? location.pathIds : null,
      categoryId: business.categoryId,
      skillIds: skillIdsFor(business.id),
      locationPath: location ? location.pathNames : null,
      summary: business.description ? business.description.slice(0, 200) : null,
      trustWeight: supplyWeight(business),
      isActive: isPubliclyVisible(business),
    }
  }

  function serviceDocument(service, business) {
    const location = locations ? locations.findById(business.primaryLocationId) : null
    return {
      docKey: `service:${service.id}`,
      sourceType: 'service',
      sourceId: service.id,
      title: service.name,
      name: service.name,
      path: `/business/${business.slug}#service-${service.slug}`,
      body: service.description ?? '',
      keywords: [business.name, location ? location.name : null]
        .filter(Boolean)
        .map((keyword) => keyword.toLowerCase()),
      locationId: business.primaryLocationId,
      locationPathIds: location ? location.pathIds : null,
      categoryId: service.category_id,
      skillIds: [],
      locationPath: location ? location.pathNames : null,
      summary: service.description ? service.description.slice(0, 200) : null,
      trustWeight: supplyWeight(business),
      // A service inherits its owner's approval. Indexing a service off a queued
      // business is the exact leak the approval rule exists to stop: the business
      // row would be absent from results while its services kept answering
      // searches with a description nobody reviewed.
      isActive: isPubliclyVisible(business) && service.is_active === 1,
    }
  }

  function productDocument(product, business) {
    const location = locations ? locations.findById(business.primaryLocationId) : null
    return {
      docKey: `product:${product.id}`,
      sourceType: 'product',
      sourceId: product.id,
      title: product.name,
      name: product.name,
      path: `/business/${business.slug}#product-${product.slug}`,
      body: [product.description, product.condition.replace(/_/g, ' ')]
        .filter(Boolean)
        .join('\n'),
      keywords: [business.name, location ? location.name : null]
        .filter(Boolean)
        .map((keyword) => keyword.toLowerCase()),
      locationId: business.primaryLocationId,
      locationPathIds: location ? location.pathIds : null,
      categoryId: product.category_id,
      skillIds: [],
      locationPath: location ? location.pathNames : null,
      summary: product.description ? product.description.slice(0, 200) : null,
      trustWeight: supplyWeight(business),
      isActive: isPubliclyVisible(business) && product.status === 'available',
    }
  }

  /**
   * Reindexes a business and everything it offers.
   *
   * Called inside the same transaction as the write that triggered it, so a
   * rolled-back write cannot leave a search document describing a business that
   * does not exist.
   */
  function reindex(businessId) {
    if (!searchIndex) return
    const row = selectById.get(businessId)
    if (!row) return
    const business = businessRow(row)

    searchIndex.index(businessDocument(business))
    for (const service of selectEveryService.all(businessId)) {
      searchIndex.index(serviceDocument(service, business))
    }
    for (const product of selectProducts.all(businessId)) {
      searchIndex.index(productDocument(product, business))
    }
  }

  const repository = {
    create(input) {
      const built = buildBusiness(input)
      // A record is only ever created into a state that means "nobody has checked
      // this yet". A caller that arrives with `approved` is either a script that
      // misunderstood the api or an operator who has decided to skip the queue, and
      // both are exactly what this phase exists to prevent, so the request is
      // refused rather than quietly downgraded: a silent downgrade publishes a
      // record nobody agreed to publish, which is the failure this rules out.
      assertIntakeState(built.verificationState)
      const id = newId()
      const slug = resolveSlug(built.slug || built.name)

      const write = db.transaction(() => {
        insert.run({
          id,
          name: built.name,
          slug,
          description: built.description,
          categoryId: built.categoryId,
          primaryLocationId: built.primaryLocationId,
          status: built.status,
          verificationState: built.verificationState,
          capabilityLevel: built.capabilityLevel,
          website: built.website,
          foundedYear: built.foundedYear,
          sourceId: input.sourceId ?? null,
          catalogueSourceId: input.catalogueSourceId ?? null,
          isOpenSource: toSqlBool(built.isOpenSource),
        })
        // The primary location also exists as a business_location row, so that
        // "everywhere this business operates" is one query regardless of whether
        // the place is its headquarters or a collection point.
        insertLocation.run({
          id: newId(),
          businessId: id,
          locationId: built.primaryLocationId,
          addressText: input.addressText ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          isPrimary: 1,
        })
        if (Array.isArray(input.skills) && input.skills.length > 0) {
          for (const [index, name] of input.skills.entries()) {
            const skill = skills.findOrCreate(name)
            insertSkill.run({
              businessId: id,
              skillId: skill.id,
              proficiency: 0.5,
              isPrimary: index === 0 ? 1 : 0,
            })
          }
        }
        reindex(id)
      })
      write()

      return repository.requireById(id)
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? businessRow(row) : null
    },

    requireById(id) {
      return businessRow(requireBusiness(id))
    },

    findBySlug(slug) {
      const row = selectBySlug.get(slug)
      return row ? businessRow(row) : null
    },

    /**
     * The same name in the same place, which is how a replayed spreadsheet is
     * recognised when a row has no contact details to compare.
     */
    findByName(name, locationId) {
      if (!name || !locationId) return null
      const row = selectByName.get(locationId, name)
      return row ? businessRow(row) : null
    },

    /**
     * Finds an existing business by any of its normalised contact points.
     *
     * This is the deduplication step for imports. Because contact values are
     * canonicalised in core/business.js, a phone number typed as
     * "0772 123 456" and as "+256772123456" produces the same value here, which
     * is what makes a spreadsheet import of Kampala businesses mergeable instead
     * of just additive.
     */
    findByContact({ kind = 'phone', value }) {
      // The kind belongs in the query, not only in the normaliser: matching on
      // value alone would report an unrelated contact as a duplicate whenever a
      // phone number and a website happened to share a string.
      const canonical = canonicalContactValue(kind, value)
      if (!canonical) return null

      // A WhatsApp number is the same business as the phone number with the same
      // digits, and the two are stored under different kinds, so a phone-shaped
      // lookup has to consider both.
      const kinds = PHONE_KINDS.has(kind) ? ['phone', 'whatsapp'] : [kind]
      for (const candidate of kinds) {
        const row = selectByContact.get({ kind: candidate, value: canonical })
        if (row) return { id: row.id, name: row.name, slug: row.slug }
      }
      return null
    },

    /** Two records describing the same business, judged on their contacts. */
    looksLikeSameBusiness(a, b) {
      if (!a?.contacts || !b?.contacts) return false
      return a.contacts.some((left) =>
        b.contacts.some((right) => contactPointsLikelySameBusiness(left, right)),
      )
    },

    all() {
      return selectAll.all().map(businessRow)
    },

    publiclyVisible() {
      return selectPublic.all().map(businessRow)
    },

    inCategory(categoryId) {
      return selectByCategory.all(categoryId).map(businessRow)
    },

    countInLocation(locationId) {
      return countByLocation.get(locationId).total
    },

    /**
     * Counts businesses, optionally including whole subtrees.
     *
     * Both joins are inner joins on NOT NULL foreign keys, so they change no
     * counts; they exist only to give the subtree predicates a path column.
     *
     * Only approved records are counted. This is the public coverage counter —
     * "how many electricians does Wakiso actually have" — and a number that
     * included records nobody had reviewed would describe a market that does not
     * exist yet. An admin wanting the raw totals asks the review queue instead.
     */
    count({
      status = 'active',
      categoryId = null,
      locationId = null,
      includeSubtree = false,
      publishedOnly = true,
    } = {}) {
      return countFiltered.get({
        status,
        categoryId,
        locationId,
        includeSubtree: includeSubtree ? 1 : 0,
        publishedOnly: publishedOnly ? 1 : 0,
      }).total
    },

    /** How many businesses the public can see. */
    countPublished() {
      return countPublished.get().total
    },

    /**
     * How many records sit in each review state, including the zeroes.
     *
     * Every state is present in the result even when nothing is in it, because
     * this is read by an operator deciding what to work on next, and a bar chart
     * with a missing column is a bar chart that has to be interpreted.
     */
    reviewCounts() {
      const rows = countByReviewState.all()
      const counts = {}
      for (const row of rows) counts[row.verification_state] = row.total
      return counts
    },

    /**
     * Filtered listing for the admin directory and the api.
     *
     * `sort` is resolved through an allowlist rather than interpolated, because
     * this is the one query whose every parameter comes from a request.
     *
     * `includeContacts` is what separates the two callers: the admin queue needs
     * the contact points on each row to decide, and the public directory must
     * not have them, because half of a survey's phone numbers are private until
     * somebody confirms the business wants to be reachable.
     */
    list({
      status,
      verificationState,
      categoryId,
      locationId,
      skillId,
      search,
      capabilityLevel,
      sort = 'newest',
      limit,
      offset,
      includeContacts = false,
      publishedOnly = false,
    } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = []
      const params = {}

      // Off by default, because the review queue needs to list what is not
      // published. When a caller asks for it, the approval requirement is added
      // as a condition rather than left to that caller, so the flag can only ever
      // narrow the result: it cannot be used to ask a different question.
      if (publishedOnly) {
        conditions.push("b.status = 'active' AND b.verification_state = 'approved'")
      }
      if (status) {
        conditions.push('b.status = @status')
        params.status = assertBusinessStatus(status)
      }
      if (verificationState) {
        conditions.push('b.verification_state = @verificationState')
        params.verificationState = assertVerificationState(verificationState)
      }
      if (capabilityLevel) {
        conditions.push('b.capability_level = @capabilityLevel')
        params.capabilityLevel = assertCapabilityLevel(capabilityLevel)
      }
      if (categoryId) {
        conditions.push('b.category_id = @categoryId')
        params.categoryId = categoryId
      }
      if (locationId) {
        conditions.push('b.primary_location_id = @locationId')
        params.locationId = locationId
      }
      if (skillId) {
        // EXISTS rather than a join: a business with three of the requested
        // skills must appear once, not three times, or the page total and the
        // rows disagree with each other.
        conditions.push(
          'EXISTS (SELECT 1 FROM business_skill bs WHERE bs.business_id = b.id AND bs.skill_id = @skillId)',
        )
        params.skillId = skillId
      }
      if (search) {
        conditions.push(
          "(b.name LIKE @search ESCAPE '\\' OR b.description LIKE @search ESCAPE '\\')",
        )
        params.search = likeParam(search)
      }

      const whereSql = where(conditions)
      // The id tiebreak keeps pagination stable: without it, rows with an equal
      // sort key can be returned in a different order per page and one of them
      // will be skipped.
      const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)
      const rows = db
        .prepare(
          `SELECT ${BUSINESS_COLUMNS} FROM business b
            ${whereSql}
            ORDER BY ${order}, b.id ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: page.limit, offset: page.offset })

      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM business b ${whereSql}`)
        .get(params).total

      const items = rows.map(businessRow)
      if (includeContacts) attachContactSummaries(items)
      return { total, items }
    },

    update(id, patch) {
      const current = businessRow(requireBusiness(id))
      // Review state is not an editable field. It changes through `review`, which
      // records who decided and why; allowing it here as well would give the
      // platform two doors to the same room, and the one without a trail is the
      // one somebody will use by accident.
      if (
        patch.verificationState !== undefined &&
        patch.verificationState !== current.verificationState
      ) {
        throw new ValidationError(
          'Review state is changed by a review action, not by editing the record.',
          { field: 'verificationState', current: current.verificationState },
        )
      }
      const merged = {
        name: patch.name ?? current.name,
        description: patch.description === undefined ? current.description : patch.description,
        categoryId: patch.categoryId ?? current.categoryId,
        locationId: patch.locationId ?? current.primaryLocationId,
        status: patch.status ?? current.status,
        verificationState: current.verificationState,
        capabilityLevel: patch.capabilityLevel ?? current.capabilityLevel,
        website: patch.website === undefined ? current.website : normaliseUrl(patch.website),
        foundedYear: patch.foundedYear ?? current.foundedYear,
        isOpenSource:
          patch.isOpenSource === undefined ? current.isOpenSource : patch.isOpenSource,
      }
      // buildBusiness is the single validator for a business shape, so an update
      // is validated by rebuilding the whole record and diffing nothing.
      const built = buildBusiness(merged)

      const write = db.transaction(() => {
        const now = nowIso()
        updateRow.run({
          id,
          name: built.name,
          description: built.description,
          categoryId: built.categoryId,
          primaryLocationId: built.primaryLocationId,
          status: built.status,
          verificationState: built.verificationState,
          capabilityLevel: built.capabilityLevel,
          website: built.website,
          foundedYear: built.foundedYear,
          isOpenSource: toSqlBool(built.isOpenSource),
          // The review pipeline owns these two. An edit may change a business's
          // details on the day it is approved, and that edit must not silently
          // move the date the facts were last checked.
          verifiedAt: current.verifiedAt,
          lastConfirmedAt: now,
          now,
        })
        if (built.primaryLocationId !== current.primaryLocationId) {
          const primary = selectLocations.all(id).find((row) => row.is_primary === 1)
          if (primary) {
            insertLocation.run({
              id: newId(),
              businessId: id,
              locationId: built.primaryLocationId,
              addressText: primary.address_text,
              latitude: primary.latitude,
              longitude: primary.longitude,
              isPrimary: 1,
            })
            deleteLocation.run(primary.id)
          }
        }
        reindex(id)
      })
      write()

      return repository.requireById(id)
    },

    /**
     * Moves a record through the review pipeline.
     *
     * This is the only way a record's review state changes, and it is one unit of
     * work on purpose. Four things have to move together, and the moment they can
     * come apart is the moment the platform starts telling people two different
     * stories about the same business:
     *
     *   - the state on the business,
     *   - the event in review_event that says who decided and why,
     *   - the timestamps and the reviewer's ownership, so a queue shows who is
     *     working on what,
     *   - the search documents, because approval is precisely the moment a listing
     *     becomes findable and a decision nobody can search is not a decision.
     *
     * `actor` is the operator who decided. It is optional so that a scripted
     * ingestion can record an event, but any call that changes what the public can
     * see should carry one: a review trail with a null actor is a review trail that
     * cannot be argued with, which is the same as no trail.
     */
    review(id, { action, actor = null, reason = null, at = null } = {}) {
      const current = requireBusiness(id)
      const from = current.verification_state
      const steps = reviewPlan(from, action)
      if (!steps) {
        throw new ConflictError(
          `A record that is ${labelFor(from)} cannot be ${String(action)}.`,
          { from, action, allowedActions: legalActions(from) },
        )
      }

      const now = at ?? nowIso()
      const write = db.transaction(() => {
        for (const step of steps) {
          applyReviewStep.run({
            id,
            to: step.to,
            now,
            ownerId: step.to === 'under_review' ? actor?.id ?? null : null,
          })
          insertReviewEvent.run({
            id: newId(),
            businessId: id,
            fromState: step.from,
            toState: step.to,
            action: step.action,
            actorId: actor?.id ?? null,
            actorRole: actor?.role ?? null,
            reason: step.action === 'claim' ? null : reason ?? null,
            sourceId: null,
            createdAt: now,
          })
        }
        reindex(id)
      })
      write()

      return repository.requireById(id)
    },

    /**
     * The same decision expressed as a target state instead of an action.
     *
     * Kept because the pre-phase-2 api and the operator queue speak in states, and
     * because "put this record into approved" is a legitimate thing for a script to
     * ask for. What it no longer does is allow the jump: the transition table in
     * core/catalogue.js applies, so a caller asking for an impossible state gets a
     * 409 naming the states it could legally reach rather than a silent write.
     */
    setVerification(id, verificationState, { at = null, actor = null, reason = null } = {}) {
      const current = requireBusiness(id)
      const target = assertVerificationState(verificationState)
      if (current.verification_state === target) return businessRow(current)
      const action = actionFor(current.verification_state, target)
      if (!action) {
        throw new ConflictError(
          `A record that is ${labelFor(current.verification_state)} cannot become ` +
            `${labelFor(target)}.`,
          {
            from: current.verification_state,
            to: target,
            allowedActions: legalActions(current.verification_state),
          },
        )
      }
      return repository.review(id, { action, actor, reason, at })
    },

    setStatus(id, status) {
      assertBusinessStatus(status)
      requireBusiness(id)
      db.prepare(`UPDATE business SET status = @status, updated_at = @now WHERE id = @id`).run({
        id,
        status,
        now: nowIso(),
      })
      const write = db.transaction(() => reindex(id))
      write()
      return repository.requireById(id)
    },

    setCapabilityLevel(id, capabilityLevel) {
      assertCapabilityLevel(capabilityLevel)
      requireBusiness(id)
      db.prepare(
        `UPDATE business SET capability_level = @level, updated_at = @now WHERE id = @id`,
      ).run({ id, level: capabilityLevel, now: nowIso() })
      const write = db.transaction(() => reindex(id))
      write()
      return repository.requireById(id)
    },

    /** Records that a business confirmed its own details. Feeds freshness. */
    confirm(id) {
      requireBusiness(id)
      const now = nowIso()
      touchConfirmed.run({ id, now })
      return repository.requireById(id)
    },

    // ---- Secondary locations ------------------------------------------------

    addLocation(businessId, { locationId, addressText, latitude, longitude, isPrimary }) {
      requireBusiness(businessId)
      if (!locationId) {
        throw new ValidationError('A business location must reference a location.', {
          field: 'locationId',
        })
      }
      if (
        db
          .prepare(
            `SELECT 1 AS present FROM business_location WHERE business_id = ? AND location_id = ?`,
          )
          .get(businessId, locationId)
      ) {
        throw new ConflictError('This business is already recorded at that location.', {
          locationId,
        })
      }
      const id = newId()
      const write = db.transaction(() => {
        if (isPrimary) {
          db.prepare(
            `UPDATE business_location SET is_primary = 0 WHERE business_id = ?`,
          ).run(businessId)
        }
        insertLocation.run({
          id,
          businessId,
          locationId,
          addressText: addressText ?? null,
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          isPrimary: isPrimary ? 1 : 0,
        })
        reindex(businessId)
      })
      write()
      return camelizeRow(
        db.prepare(`SELECT * FROM business_location WHERE id = ?`).get(id),
      )
    },

    locations(businessId) {
      return camelizeRows(selectLocations.all(businessId)).map((row) => ({
        ...row,
        isPrimary: fromSqlBool(row.isPrimary),
      }))
    },

    removeLocation(businessId, locationRowId) {
      const row = db
        .prepare(
          `SELECT * FROM business_location WHERE id = ? AND business_id = ?`,
        )
        .get(locationRowId, businessId)
      if (!row) throw new NotFoundError('BusinessLocation', locationRowId)
      if (row.is_primary === 1) {
        throw new ConflictError(
          'The primary location cannot be removed. Move the business first.',
        )
      }
      deleteLocation.run(locationRowId)
      const write = db.transaction(() => reindex(businessId))
      write()
      return true
    },

    // ---- Contacts -----------------------------------------------------------

    /**
     * Adds a contact point.
     *
     * A phone number is the strongest identity signal a Ugandan business has, so
     * adding one that already belongs to another business is reported as a
     * possible duplicate rather than silently accepted.
     */
    addContact(businessId, input) {
      requireBusiness(businessId)
      const contact = buildContactPoint(input)
      const id = newId()

      const write = db.transaction(() => {
        if (
          db
            .prepare(
              `SELECT 1 AS present FROM contact_point
                WHERE business_id = ? AND kind = ? AND value = ?`,
            )
            .get(businessId, contact.kind, contact.value)
        ) {
          throw new ConflictError(
            `This business already has that ${contact.kind}.`,
            { kind: contact.kind, value: contact.value },
          )
        }
        if (contact.isPrimary) {
          db.prepare(
            `UPDATE contact_point SET is_primary = 0 WHERE business_id = ? AND kind = ?`,
          ).run(businessId, contact.kind)
        }
        insertContact.run({
          id,
          businessId,
          kind: contact.kind,
          value: contact.value,
          isPrimary: contact.isPrimary ? 1 : 0,
          isPublic: toSqlBool(contact.isPublic),
        })
      })
      write()

      return {
        id,
        businessId,
        kind: contact.kind,
        value: contact.value,
        isPrimary: contact.isPrimary,
        isPublic: contact.isPublic,
      }
    },

    contacts(businessId) {
      return camelizeRows(selectContacts.all(businessId)).map((row) => ({
        ...row,
        isPrimary: fromSqlBool(row.isPrimary),
        isPublic: fromSqlBool(row.isPublic),
      }))
    },

    /** The only contacts that may be shown publicly. */
    publicContacts(businessId) {
      return camelizeRows(selectPublicContacts.all(businessId)).map((row) => ({
        ...row,
        isPrimary: fromSqlBool(row.isPrimary),
      }))
    },

    setContactVisibility(contactId, { isPublic, isPrimary } = {}) {
      const row = db.prepare(`SELECT * FROM contact_point WHERE id = ?`).get(contactId)
      if (!row) throw new NotFoundError('ContactPoint', contactId)
      updateContact.run({
        id: contactId,
        isPublic: toSqlBool(isPublic ?? fromSqlBool(row.is_public)),
        isPrimary: toSqlBool(isPrimary ?? fromSqlBool(row.is_primary)),
        now: nowIso(),
      })
      const write = db.transaction(() => reindex(row.business_id))
      write()
      return camelizeRow(
        db.prepare(`SELECT * FROM contact_point WHERE id = ?`).get(contactId),
      )
    },

    removeContact(contactId) {
      const row = db.prepare(`SELECT * FROM contact_point WHERE id = ?`).get(contactId)
      if (!row) throw new NotFoundError('ContactPoint', contactId)
      deleteContact.run(contactId)
      const write = db.transaction(() => reindex(row.business_id))
      write()
      return true
    },

    // ---- Services -----------------------------------------------------------

    addService(businessId, input) {
      requireBusiness(businessId)
      const name = String(input.name ?? '').trim()
      if (name.length < 2 || name.length > 160) {
        throw new ValidationError('A service name must be 2 to 160 characters.', {
          field: 'name',
        })
      }
      const categoryId = input.categoryId ?? this.requireById(businessId).categoryId
      const id = newId()
      const slug = slugify(input.slug || name)

      const write = db.transaction(() => {
        insertService.run({
          id,
          businessId,
          categoryId,
          name,
          slug,
          description: input.description ?? null,
          priceMin: numberOrNull(input.priceMin),
          priceMax: numberOrNull(input.priceMax),
          priceUnit: input.priceUnit ?? null,
        })
        for (const skillName of input.skills ?? []) {
          const skill = skills.findOrCreate(skillName)
          linkServiceSkill.run(id, skill.id)
        }
        reindex(businessId)
      })
      write()

      return camelizeRow(selectService.get(id))
    },

    services(businessId) {
      return camelizeRows(selectServices.all(businessId)).map((row) => ({
        ...row,
        isActive: fromSqlBool(row.isActive),
      }))
    },

    updateService(serviceId, patch) {
      const current = selectService.get(serviceId)
      if (!current) throw new NotFoundError('Service', serviceId)
      const write = db.transaction(() => {
        updateService.run({
          id: serviceId,
          name: patch.name ?? current.name,
          description:
            patch.description === undefined ? current.description : patch.description,
          categoryId: patch.categoryId ?? current.category_id,
          priceMin:
            patch.priceMin === undefined ? current.price_min : numberOrNull(patch.priceMin),
          priceMax:
            patch.priceMax === undefined ? current.price_max : numberOrNull(patch.priceMax),
          priceUnit: patch.priceUnit === undefined ? current.price_unit : patch.priceUnit,
          isActive:
            patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
          now: nowIso(),
        })
        reindex(current.business_id)
      })
      write()
      return camelizeRow(selectService.get(serviceId))
    },

    removeService(serviceId) {
      const current = selectService.get(serviceId)
      if (!current) throw new NotFoundError('Service', serviceId)
      deleteService.run(serviceId)
      if (searchIndex) searchIndex.removeSource('service', serviceId)
      const write = db.transaction(() => reindex(current.business_id))
      write()
      return true
    },

    // ---- Products -----------------------------------------------------------

    addProduct(businessId, input) {
      requireBusiness(businessId)
      const name = String(input.name ?? '').trim()
      if (name.length < 2 || name.length > 160) {
        throw new ValidationError('A product name must be 2 to 160 characters.', {
          field: 'name',
        })
      }
      const condition = assertProductCondition(input.condition ?? 'unknown')
      const categoryId = input.categoryId ?? this.requireById(businessId).categoryId
      const id = newId()

      const write = db.transaction(() => {
        insertProduct.run({
          id,
          businessId,
          categoryId,
          name,
          slug: slugify(input.slug || name),
          description: input.description ?? null,
          condition,
          quantity: Number.isInteger(input.quantity) ? input.quantity : null,
          priceMin: numberOrNull(input.priceMin),
          priceMax: numberOrNull(input.priceMax),
          currency: input.currency ?? 'UGX',
          isRecyclable: toSqlBool(Boolean(input.isRecyclable)),
          status: input.status ?? 'available',
        })
        reindex(businessId)
      })
      write()

      return productRow(selectProduct.get(id))
    },

    products(businessId) {
      return selectProducts.all(businessId).map(productRow)
    },

    updateProduct(productId, patch) {
      const current = selectProduct.get(productId)
      if (!current) throw new NotFoundError('Product', productId)
      if (patch.condition) assertProductCondition(patch.condition)
      const write = db.transaction(() => {
        updateProduct.run({
          id: productId,
          name: patch.name ?? current.name,
          description:
            patch.description === undefined ? current.description : patch.description,
          categoryId: patch.categoryId ?? current.category_id,
          condition: patch.condition ?? current.condition,
          quantity: patch.quantity === undefined ? current.quantity : patch.quantity,
          priceMin:
            patch.priceMin === undefined ? current.price_min : numberOrNull(patch.priceMin),
          priceMax:
            patch.priceMax === undefined ? current.price_max : numberOrNull(patch.priceMax),
          currency: patch.currency ?? current.currency,
          isRecyclable:
            patch.isRecyclable === undefined
              ? current.is_recyclable
              : toSqlBool(patch.isRecyclable),
          status: patch.status ?? current.status,
          now: nowIso(),
        })
        reindex(current.business_id)
      })
      write()
      return productRow(selectProduct.get(productId))
    },

    removeProduct(productId) {
      const current = selectProduct.get(productId)
      if (!current) throw new NotFoundError('Product', productId)
      deleteProduct.run(productId)
      if (searchIndex) searchIndex.removeSource('product', productId)
      const write = db.transaction(() => reindex(current.business_id))
      write()
      return true
    },

    /**
     * Product stock for the Second Life Electronics vertical.
     *
     * Public, so the owning business has to be public: this returns the seller's
     * name and slug, and a product left on a listing that is still in the review
     * queue is a business nobody has agreed to publish.
     */
    findRecyclableProducts({ condition = null, limit = 50, offset = 0 } = {}) {
      const page = normalisePagination({ limit, offset })
      const conditions = [
        'p.is_recyclable = 1',
        "p.status = 'available'",
        "b.status = 'active'",
        "b.verification_state = 'approved'",
      ]
      const params = { limit: page.limit, offset: page.offset }
      if (condition) {
        conditions.push('p.condition = @condition')
        params.condition = assertProductCondition(condition)
      }
      return db
        .prepare(
          `SELECT p.*, b.name AS business_name, b.slug AS business_slug
             FROM product p
             JOIN business b ON b.id = p.business_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY p.created_at DESC
            LIMIT @limit OFFSET @offset`,
        )
        .all(params)
        .map((row) => ({ ...productRow(row), businessName: row.business_name }))
    },

    // ---- Skills -------------------------------------------------------------

    addSkill(businessId, skillName, { proficiency = 0.5, isPrimary = false } = {}) {
      requireBusiness(businessId)
      if (typeof proficiency !== 'number' || proficiency < 0 || proficiency > 1) {
        throw new ValidationError('Skill proficiency must be between 0 and 1.', {
          field: 'proficiency',
        })
      }
      const skill = skills.findOrCreate(skillName)
      const write = db.transaction(() => {
        insertSkill.run({
          businessId,
          skillId: skill.id,
          proficiency,
          isPrimary: isPrimary ? 1 : 0,
        })
        reindex(businessId)
      })
      write()
      return skill
    },

    skills(businessId) {
      return camelizeRows(selectSkills.all(businessId)).map((row) => ({
        ...row,
        isPrimary: fromSqlBool(row.isPrimary),
      }))
    },

    removeSkill(businessId, skillId) {
      removeSkill.run(businessId, skillId)
      const write = db.transaction(() => reindex(businessId))
      write()
      return true
    },

    // ---- Whole-profile read -------------------------------------------------

    /**
     * Everything about one business in one call. The public profile page, the
     * admin editor and the api all want this shape, and three separate
     * round-trips to assemble it is three chances to forget that a contact is
     * private.
     */
    profile(businessId, { includePrivateContacts = false } = {}) {
      const business = repository.requireById(businessId)
      return {
        ...business,
        locations: repository.locations(businessId),
        contacts: includePrivateContacts
          ? repository.contacts(businessId)
          : repository.publicContacts(businessId),
        services: repository.services(businessId),
        products: repository.products(businessId),
        skills: repository.skills(businessId),
      }
    },

    /**
     * The supply measurement the gap engine reads.
     *
     * Returns raw per-business weights rather than an aggregate, because the
     * aggregation has to happen per coverage location and per category, and
     * doing that here would bake the intelligence layer's shape into the data
     * layer.
     */
    supplySnapshot() {
      return supplyRows
        .all()
        .map((row) => ({
          id: row.id,
          primaryLocationId: row.primary_location_id,
          capabilityLevel: row.capability_level,
          weight: supplyWeight({
            status: row.status,
            verificationState: row.verification_state,
            capabilityLevel: row.capability_level,
          }),
        }))
    },

    reindex,
  }

  return repository
}

function productRow(row) {
  const record = camelizeRow(row)
  record.isRecyclable = fromSqlBool(record.isRecyclable)
  return record
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
