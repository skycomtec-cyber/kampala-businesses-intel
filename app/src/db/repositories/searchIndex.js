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
  const selectDocumentIds = db.prepare(`SELECT id FROM search_document`)
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

    count() {
      return selectDocumentIds.all().length
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
