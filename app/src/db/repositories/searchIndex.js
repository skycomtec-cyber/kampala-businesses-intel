import { tokenise } from '../../core/demand.js'
import { NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, camelizeJsonRows, nowIso, parseJson, toJson } from '../mapping.js'
import { normalisePagination } from './common.js'

/**
 * The search index.
 *
 * `search_document` is the source of truth for what is searchable; `search_index`
 * is a derived FTS5 table keyed by that row's id. Splitting them means the text
 * of an index can be rebuilt, re-tokenised or re-weighted without touching a
 * single business row, and it means a document that is not searchable (a
 * suspended business, a deactivated category) can be excluded by a flag rather
 * than by deleting its content.
 *
 * The repository is the only writer of both tables, and it writes them in one
 * transaction. That is the reason there is no trigger keeping the FTS table in
 * sync: an index that is rebuilt in one statement is an index that cannot drift.
 */

const DOCUMENT_COLUMNS = `
  id, doc_key, source_type, source_id, title, path, location_id, location_path_ids,
  category_id, skill_ids, trust_weight, location_path, summary, is_active, indexed_at
`

const SOURCE_TYPES = new Set([
  'business',
  'service',
  'product',
  'category',
  'skill',
  'place',
])

export function createSearchIndexRepository(db) {
  const upsertDocument = db.prepare(
    `INSERT INTO search_document (
       doc_key, source_type, source_id, title, path, location_id, location_path_ids,
       category_id, skill_ids, trust_weight, location_path, summary, is_active
     ) VALUES (
       @docKey, @sourceType, @sourceId, @title, @path, @locationId, @locationPathIds,
       @categoryId, @skillIds, @trustWeight, @locationPath, @summary, @isActive
     )
     ON CONFLICT(doc_key) DO UPDATE SET
       source_type  = excluded.source_type,
       source_id    = excluded.source_id,
       title        = excluded.title,
       path         = excluded.path,
       location_id  = excluded.location_id,
       location_path_ids = excluded.location_path_ids,
       category_id  = excluded.category_id,
       skill_ids    = excluded.skill_ids,
       trust_weight = excluded.trust_weight,
       location_path = excluded.location_path,
       summary      = excluded.summary,
       is_active    = excluded.is_active,
       indexed_at   = excluded.indexed_at`,
  )
  const selectDocument = db.prepare(
    `SELECT ${DOCUMENT_COLUMNS} FROM search_document WHERE doc_key = ?`,
  )
  const selectDocumentsBySource = db.prepare(
    `SELECT ${DOCUMENT_COLUMNS} FROM search_document WHERE source_type = ? AND source_id = ?`,
  )
  const countDocuments = db.prepare(
    `SELECT COUNT(*) AS total FROM search_document
      WHERE (@publishedOnly = 0 OR is_active = 1)`,
  )
  const insertFts = db.prepare(
    `INSERT INTO search_index (rowid, name, body, keywords) VALUES (?, ?, ?, ?)`,
  )
  const deleteFts = db.prepare(`DELETE FROM search_index WHERE rowid = ?`)
  const deleteDocument = db.prepare(`DELETE FROM search_document WHERE doc_key = ?`)
  const deleteFtsBySource = db.prepare(
    `DELETE FROM search_index WHERE rowid IN (
       SELECT id FROM search_document WHERE source_type = ? AND source_id = ?
     )`,
  )
  const deleteDocumentsBySource = db.prepare(
    `DELETE FROM search_document WHERE source_type = ? AND source_id = ?`,
  )
  const clearAll = db.prepare(`DELETE FROM search_index`)
  const clearDocuments = db.prepare(`DELETE FROM search_document`)

  /**
   * Builds a document record and syncs the FTS row in one transaction.
   *
   * The delete-then-insert of the FTS row is what makes re-indexing idempotent:
   * an FTS5 table is a content table, so an update is a delete of the old rowid
   * plus an insert of the new text, not an in-place edit.
   */
  const write = db.transaction((input) => {
    if (!SOURCE_TYPES.has(input.sourceType)) {
      throw new ValidationError(`Cannot index an unknown source type "${input.sourceType}".`)
    }
    const docKey = input.docKey ?? `${input.sourceType}:${input.sourceId}`

    upsertDocument.run({
      docKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      title: input.title,
      path: input.path,
      locationId: input.locationId ?? null,
      locationPathIds: input.locationPathIds ?? null,
      categoryId: input.categoryId ?? null,
      skillIds: toJson(input.skillIds ?? []),
      trustWeight: Number(input.trustWeight ?? 0),
      locationPath: input.locationPath ?? null,
      summary: input.summary ?? null,
      isActive: input.isActive === false ? 0 : 1,
      indexedAt: nowIso(),
    })

    const row = selectDocument.get(docKey)
    deleteFts.run(row.id)
    if (row.is_active === 1) {
      insertFts.run(
        row.id,
        input.name ?? input.title,
        input.body ?? '',
        (input.keywords ?? []).join(' '),
      )
    }
    return camelizeRow(row)
  })

  return {
    index(input) {
      return write(input)
    },

    /**
     * Indexes many documents in a single transaction. Used by the importers and
     * by reindexAll, where a per-document transaction would dominate the runtime.
     */
    indexMany(inputs) {
      const apply = db.transaction((list) => list.map((input) => write(input)))
      return apply(inputs)
    },

    remove(docKey) {
      const drop = db.transaction((key) => {
        const row = selectDocument.get(key)
        if (!row) return false
        deleteFts.run(row.id)
        deleteDocument.run(key)
        return true
      })
      return drop(docKey)
    },

    removeSource(sourceType, sourceId) {
      const drop = db.transaction(() => {
        deleteFtsBySource.run(sourceType, sourceId)
        deleteDocumentsBySource.run(sourceType, sourceId)
      })
      drop()
      return true
    },

    find(docKey) {
      const row = selectDocument.get(docKey)
      return row ? camelizeJsonRow(row) : null
    },

    forSource(sourceType, sourceId) {
      return camelizeJsonRows(selectDocumentsBySource.all(sourceType, sourceId), [
        'skillIds',
      ])
    },

    /**
     * Empties the index. The caller is responsible for rebuilding it; a reindex
     * that deletes first is the only way to guarantee no orphaned row survives a
     * schema change to the source tables.
     */
    clear() {
      const wipe = db.transaction(() => {
        clearAll.run()
        clearDocuments.run()
      })
      wipe()
      return true
    },

    /**
     * Runs an FTS5 query.
     *
     * Ranking is bm25 across the three columns with `name` weighted highest,
     * then a small trust bonus. The trust bonus is deliberately minor: a
     * perfectly matched unverified listing should still outrank a vaguely matched
     * verified one, because relevance is what the person searching actually
     * asked for.
     */
    search({
      query,
      locationId = null,
      categoryId = null,
      skillId = null,
      sourceTypes = null,
      includeInactive = false,
      limit = 25,
      offset = 0,
    }) {
      const match = buildMatchExpression(query)
      if (!match) return { total: 0, items: [] }

      const page = normalisePagination({ limit, offset })
      const conditions = ['search_index MATCH @match']
      const filters = { match }

      if (!includeInactive) conditions.push('d.is_active = 1')
      if (locationId) {
        // Prefix match on the materialised path, so "search inside this
        // district" covers every city, sub-county and ward beneath it without
        // resolving the district's descendants first.
        conditions.push(
          `('/' || d.location_path_ids || '/') LIKE '%/' || @locationPathId || '/%'`,
        )
        filters.locationPathId = locationId
      }
      if (categoryId) {
        conditions.push('d.category_id = @categoryId')
        filters.categoryId = categoryId
      }
      if (skillId) {
        // skill_ids is a JSON array, so containment is tested against the
        // serialised text. The set of skills on one document is short enough that
        // this beats a join on a large candidate set.
        conditions.push(`d.skill_ids LIKE '%"' || @skillId || '"%'`)
        filters.skillId = skillId
      }
      if (sourceTypes && sourceTypes.length > 0) {
        const placeholders = sourceTypes.map((_, index) => `@type${index}`)
        sourceTypes.forEach((type, index) => {
          filters[`type${index}`] = type
        })
        conditions.push(`d.source_type IN (${placeholders.join(', ')})`)
      }

      const where = conditions.join(' AND ')
      const rows = db
        .prepare(
          `SELECT ${DOCUMENT_COLUMNS},
                  bm25(search_index, 10.0, 4.0, 8.0) AS bm25_rank
             FROM search_index
             JOIN search_document d ON d.id = search_index.rowid
            WHERE ${where}
            ORDER BY bm25_rank ASC, d.trust_weight DESC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...filters, limit: page.limit, offset: page.offset })

      const total = db
        .prepare(
          `SELECT COUNT(*) AS total
             FROM search_index
             JOIN search_document d ON d.id = search_index.rowid
            WHERE ${where}`,
        )
        .get(filters).total

      return { total, items: camelizeJsonRows(rows, ['skillIds']) }
    },

    /**
     * Measures how much supply the platform has for a phrase in a place.
     *
     * The gap engine compares demand against supply, and supply here is not a
     * document count. One business whose name, three services and two products
     * all match "laptop repair" is one business that can serve the demand, so a
     * raw row count would let a single well-listed trader invent a market's worth
     * of coverage and the gap would silently close. So the query resolves every
     * matching document to its owning business, groups by that business, and
     * sums `trust_weight` once per business. Since `trust_weight` is
     * `supplyWeight(business)` and is identical on all of one business's
     * documents, MAX() over the group is that business's weight exactly.
     *
     * `locationId` scopes the same way `search()` does, as a prefix match on the
     * materialised path, so a district figure covers the cities and wards inside
     * it. A null `locationId` measures the whole country, which is the right
     * answer for a countrywide search.
     *
     * Read-only and unranked: a gap asks "how much supply exists", not "what
     * would rank first", so bm25 and paging would only add cost and a second
     * answer to the same question.
     */
    supplyFor({ query, locationId = null }) {
      const match = buildMatchExpression(query)
      if (!match) {
        return {
          businessCount: 0,
          supplyScore: 0,
          verifiedCount: 0,
          documentCount: 0,
          bySource: { business: 0, service: 0, product: 0 },
        }
      }

      const filters = { match }
      // Interpolated into two CTEs below, so it is built once here rather than
      // nested into the query template twice. `d` is the alias both CTEs use.
      const locationClause = locationId
        ? `AND ('/' || d.location_path_ids || '/') LIKE '%/' || @locationId || '/%'`
        : ''
      if (locationId) filters.locationId = locationId

      const row = db
        .prepare(
          `WITH matched AS (
             SELECT d.source_type, d.source_id, d.trust_weight
               FROM search_index
               JOIN search_document d ON d.id = search_index.rowid
              WHERE search_index MATCH @match
                AND d.is_active = 1
                AND d.source_type IN ('business','service','product')
                ${locationClause}
           ),
           all_business_matches AS (
             -- The same phrase match, but ignoring is_active, because the question
             -- this CTE answers is whether anybody here has been checked at all,
             -- and a business still awaiting publication has not.
             SELECT d.source_id AS business_id
               FROM search_index
               JOIN search_document d ON d.id = search_index.rowid
              WHERE search_index MATCH @match
                AND d.source_type = 'business'
                ${locationClause}
           ),
           owners AS (
             SELECT COALESCE(
                      CASE WHEN m.source_type = 'business' THEN m.source_id END,
                      s.business_id,
                      p.business_id
                    ) AS business_id,
                    m.trust_weight
               FROM matched m
               LEFT JOIN service s ON m.source_type = 'service' AND s.id = m.source_id
               LEFT JOIN product p ON m.source_type = 'product' AND p.id = m.source_id
           ),
           per_business AS (
             -- MAX, not SUM: all of one business's documents carry the same
             -- trust_weight, so this is that business's weight counted once.
             SELECT o.business_id, MAX(o.trust_weight) AS trust_weight
               FROM owners o
              WHERE o.business_id IS NOT NULL
              GROUP BY o.business_id
           )
            SELECT
              (SELECT COUNT(*) FROM per_business) AS business_count,
              (SELECT COALESCE(SUM(trust_weight), 0) FROM per_business) AS supply_score,
              -- Counted across every matching business document, published or
              -- not, rather than across the per_business CTE. A business only reaches
              -- the active index by being approved, so measuring "verified"
              -- inside the active set would just re-count business_count and
              -- learn nothing. Counting it outside the active set is the
              -- question worth answering: is there supply here that has been
              -- checked but is still sitting in the review queue? A gap with
              -- verified_count far above business_count is not a market, it is a
              -- backlog, and the lab needs to be able to tell those apart.
              (SELECT COUNT(DISTINCT b.id)
                 FROM all_business_matches m
                 JOIN business b ON b.id = m.business_id
                WHERE b.verification_state IN ('verified', 'approved')) AS verified_count,
              (SELECT COUNT(*) FROM matched) AS document_count,
              (SELECT COUNT(*) FROM matched WHERE source_type = 'business') AS business_docs,
              (SELECT COUNT(*) FROM matched WHERE source_type = 'service') AS service_docs,
              (SELECT COUNT(*) FROM matched WHERE source_type = 'product') AS product_docs`,
        )
        .get(filters)

      return {
        businessCount: row.business_count,
        supplyScore: row.supply_score,
        verifiedCount: row.verified_count,
        documentCount: row.document_count,
        bySource: {
          business: row.business_docs,
          service: row.service_docs,
          product: row.product_docs,
        },
      }
    },

    /**
     * A census of supply in a place, with no phrase involved.
     *
     * The other half of supply measurement from `supplyFor`: that one answers
     * "how much supply exists for what people are asking about", this answers
     * "how much supply exists here at all". The lab needs both - a district can
     * be well stocked overall and still have one large gap, and the gap number
     * alone cannot tell those apart from a district that is empty.
     *
     * Read from `search_document` rather than the business tables because that is
     * the same set of rows `supplyFor` measures, so the two numbers are
     * guaranteed to be talking about the same supply. `is_active` already
     * encodes public visibility per document, so no join to business is needed
     * for the counts.
     */
    supplyTotals({ locationId = null } = {}) {
      const conditions = ["is_active = 1", "source_type IN ('business','service','product')"]
      const filters = {}
      // Three places below filter on the location path, and each is either the
      // bare search_document or the same table aliased `d`. Both forms are built
      // here so the query template stays free of nested literals.
      const scopePlain = locationId
        ? `AND ('/' || location_path_ids || '/') LIKE '%/' || @locationId || '/%'`
        : ''
      const scopeAliased = locationId
        ? `AND ('/' || d.location_path_ids || '/') LIKE '%/' || @locationId || '/%'`
        : ''
      if (locationId) {
        conditions.push(scopePlain.slice(4))
        filters.locationId = locationId
      }
      const whereSql = conditions.join(' AND ')

      const row = db
        .prepare(
          `SELECT COUNT(*) AS document_count,
                  SUM(CASE WHEN source_type = 'business' THEN 1 ELSE 0 END) AS business_count,
                  SUM(CASE WHEN source_type = 'service'  THEN 1 ELSE 0 END) AS service_count,
                  SUM(CASE WHEN source_type = 'product'  THEN 1 ELSE 0 END) AS product_count,
                  -- One weight per business, not per document: the same reason
                  -- supplyFor groups by owner. A business with five services is
                  -- one unit of supply, not six.
                  (SELECT COALESCE(SUM(pb.trust_weight), 0) FROM (
                     SELECT MAX(trust_weight) AS trust_weight
                       FROM search_document
                      WHERE is_active = 1 AND source_type = 'business'
                        ${scopePlain}
                      GROUP BY source_id
                   ) pb) AS supply_score,
                  (SELECT COUNT(DISTINCT b.id) FROM search_document d
                    JOIN business b ON b.id = d.source_id
                   WHERE d.source_type = 'business'
                     AND b.verification_state IN ('verified', 'approved')
                     ${scopeAliased}) AS verified_count
             FROM search_document
            WHERE ${whereSql}`,
        )
        .get(filters)

      return {
        businessCount: row.business_count ?? 0,
        serviceCount: row.service_count ?? 0,
        productCount: row.product_count ?? 0,
        documentCount: row.document_count ?? 0,
        supplyScore: row.supply_score ?? 0,
        verifiedCount: row.verified_count ?? 0,
      }
    },

    /**
     * Rebuilds the whole index from the source tables.
     *
     * `build` receives a fresh document list from the caller, because only the
     * supply layer knows how a business, a service and a product each become a
     * document. This repository deliberately knows nothing about that mapping.
     */
    rebuild(build) {
      const run = db.transaction(() => {
        clearAll.run()
        clearDocuments.run()
        return build()
      })
      const documents = run()
      const count = this.indexMany(documents)
      return count.length
    },

    /**
     * How many documents the public can be served from.
     *
     * A document is kept after its record stops being public, because the record
     * is usually only rejected or withdrawn, and re-reviewing it later is cheaper
     * than rebuilding its documents. So the raw row count is not the size of the
     * public index, it is the size of the public index plus the queue.
     */
    count({ publishedOnly = true } = {}) {
      return countDocuments.get({ publishedOnly: publishedOnly ? 1 : 0 }).total
    },

    require(docKey) {
      const document = this.find(docKey)
      if (!document) throw new NotFoundError('SearchDocument', docKey)
      return document
    },
  }
}

function camelizeJsonRow(row) {
  const record = camelizeRow(row)
  record.skillIds = parseJson(record.skillIds, [])
  return record
}

/**
 * Turns free text into a safe FTS5 MATCH expression.
 *
 * Two rules, both learned the hard way by anyone who has let a user type into an
 * FTS box: a bare token can be a column filter (`OR`, `NOT`, `NEAR`) and will
 * either error or silently rewrite the query, and a trailing prefix operator is
 * what makes "lapto" find "laptop". So every token is quoted, which makes it a
 * literal string, and the final token gets the prefix star.
 */
export function buildMatchExpression(rawQuery) {
  const tokens = tokenise(rawQuery).filter((token) => token.length > 0).slice(0, 12)
  if (tokens.length === 0) return null

  const terms = tokens.map((token, index) => {
    const literal = `"${token.replace(/"/g, '""')}"`
    return index === tokens.length - 1 ? `${literal}*` : literal
  })
  return terms.join(' ')
}
