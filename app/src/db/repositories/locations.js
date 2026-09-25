import { newId, slugify } from '../../core/identifiers.js'
import {
  assertLocationKind,
  assertParentAllowed,
  validateCoordinates,
  assertCoverageLevel,
  COVERAGE_LEVELS,
} from '../../core/location.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import { camelizeRow, camelizeRows, nowIso } from '../mapping.js'
import { normalisePagination } from './common.js'

/**
 * The administrative geography.
 *
 * Every read that rolls demand or supply up the hierarchy uses the materialised
 * `path_ids` column, so "everything inside Wakiso district" is a single
 * prefix-match query rather than a recursive walk per row. Ancestors cannot be
 * found that way, because an ancestor's path does not contain its descendant's
 * id, so those walk parent_id upwards. The tree is five levels deep, which keeps
 * both directions cheap.
 */

const LOCATION_COLUMNS = `
  id, kind, name, slug, parent_id, latitude, longitude,
  external_code, source_id, is_active, path_ids, path_names, depth,
  created_at, updated_at
`

const REFERENCE_PAGE_SIZE = 500

export function createLocationsRepository(db) {
  const insert = db.prepare(
    `INSERT INTO location (
       id, kind, name, slug, parent_id, latitude, longitude, external_code, source_id
     ) VALUES (
       @id, @kind, @name, @slug, @parentId, @latitude, @longitude, @externalCode, @sourceId
     )`,
  )
  const selectById = db.prepare(`SELECT ${LOCATION_COLUMNS} FROM location WHERE id = ?`)
  const selectByExternal = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location WHERE external_code = ?`,
  )
  const selectBySlug = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location WHERE slug = ? AND parent_id IS ?`,
  )
  const selectChildren = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location
      WHERE parent_id IS ? AND is_active = 1
      ORDER BY name ASC`,
  )
  // The materialised path is a slash-joined list of ids, so a containment test
  // wraps both sides in slashes: matching a bare id would let one location's id
  // be found inside another's by coincidence.
  const selectDescendants = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location
      WHERE ('/' || path_ids || '/') LIKE '%/' || ? || '/%'
        AND id <> ?
        AND is_active = 1
      ORDER BY depth ASC, name ASC`,
  )
  // Descendants can be found by prefix-matching the path, but ancestors cannot:
  // an ancestor's own path does not contain the descendant's id. So walk the
  // parent_id chain upwards. The tree is five levels deep and parent_id is
  // indexed, so this stays a handful of index lookups.
  const selectAncestors = db.prepare(
    `WITH RECURSIVE chain(id) AS (
       SELECT id FROM location WHERE id = ?
       UNION ALL
       SELECT parent_id FROM location JOIN chain ON location.id = chain.id
        WHERE location.parent_id IS NOT NULL
     )
     SELECT ${LOCATION_COLUMNS} FROM location
      WHERE id IN (SELECT id FROM chain) AND id <> ?
      ORDER BY depth ASC`,
  )
  const selectByKind = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location
      WHERE kind = ? AND is_active = 1
      ORDER BY name ASC
      LIMIT ? OFFSET ?`,
  )
  const selectAll = db.prepare(
    `SELECT ${LOCATION_COLUMNS} FROM location
      WHERE is_active = 1
      ORDER BY depth ASC, name ASC
      LIMIT ? OFFSET ?`,
  )
  const countActive = db.prepare(
    `SELECT COUNT(*) AS total FROM location WHERE is_active = 1`,
  )
  const countByKindTotal = db.prepare(
    `SELECT COUNT(*) AS total FROM location WHERE kind = ? AND is_active = 1`,
  )
  const countByKind = db.prepare(
    `SELECT kind, COUNT(*) AS total FROM location WHERE is_active = 1 GROUP BY kind`,
  )
  const updateRow = db.prepare(
    `UPDATE location
        SET name = @name,
            slug = @slug,
            latitude = @latitude,
            longitude = @longitude,
            external_code = @externalCode,
            is_active = @isActive,
            updated_at = @now
      WHERE id = @id`,
  )
  const upsertSource = db.prepare(
    `INSERT INTO reference_source (id, name, kind, version, source_uri, licence, row_count, notes)
     VALUES (@id, @name, @kind, @version, @sourceUri, @licence, @rowCount, @notes)
     ON CONFLICT(id) DO UPDATE SET
       applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       row_count = excluded.row_count`,
  )
  // parent_id is ON DELETE RESTRICT, so every row is reachable from a root and
  // the walk covers the whole table. The recursion emits a parent before its
  // children, which is what lets each row read its parent's already-written path
  // instead of the whole table having to be sorted into dependency order first.
  const selectTree = db.prepare(
    `WITH RECURSIVE tree(id, name, path_ids, path_names, depth) AS (
       SELECT id, name, id, name, 0
         FROM location
        WHERE parent_id IS NULL
       UNION ALL
       SELECT child.id, child.name,
              parent.path_ids || '/' || child.id,
              parent.path_names || ' / ' || child.name,
              parent.depth + 1
         FROM location AS child
         JOIN tree AS parent ON child.parent_id = parent.id
     )
     SELECT id, path_ids AS pathIds, path_names AS pathNames, depth FROM tree`,
  )
  const writePath = db.prepare(
    `UPDATE location
        SET path_ids = @pathIds, path_names = @pathNames, depth = @depth
      WHERE id = @id`,
  )

  function requireLocation(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Location', id)
    return row
  }

  /**
   * Validates the parent/child relationship against the stored row rather than
   * against the caller's word, so a location can never be nested inside a level
   * that core/location.js forbids even if the api layer skipped the check.
   */
  function assertHierarchy(kind, parentId) {
    if (!parentId) {
      assertParentAllowed(kind, null)
      return null
    }
    const parent = requireLocation(parentId)
    assertParentAllowed(kind, parent.kind)
    return parent
  }

  /** Shared by `listByKind` and the bare-array `byKind` above it. */
  function listByKind(kind, { limit = REFERENCE_PAGE_SIZE, offset = 0 } = {}) {
    assertLocationKind(kind)
    const page = normalisePagination({ limit, offset })
    return {
      items: camelizeRows(selectByKind.all(kind, page.limit, page.offset)),
      total: countByKindTotal.get(kind).total,
    }
  }

  const repository = {
    create(input) {
      const kind = assertLocationKind(input.kind)
      const name = String(input.name ?? '').trim()
      if (name.length < 2 || name.length > 160) {
        throw new ValidationError('A location name must be 2 to 160 characters.', {
          field: 'name',
        })
      }
      const parentId = input.parentId ?? null
      assertHierarchy(kind, parentId)
      const { latitude, longitude } = validateCoordinates({
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      })
      const slug = slugify(input.slug || name)
      if (selectBySlug.get(slug, parentId)) {
        throw new ConflictError(
          `A ${kind} named "${name}" already exists in that parent.`,
          { slug, parentId },
        )
      }

      const id = newId()
      insert.run({
        id,
        kind,
        name,
        slug,
        parentId,
        latitude,
        longitude,
        externalCode: input.externalCode ?? null,
        sourceId: input.sourceId ?? null,
      })
      return camelizeRow(selectById.get(id))
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? camelizeRow(row) : null
    },

    requireById(id) {
      return camelizeRow(requireLocation(id))
    },

    findByExternalCode(code) {
      const row = selectByExternal.get(code)
      return row ? camelizeRow(row) : null
    },

    findBySlug(slug, parentId = null) {
      const row = selectBySlug.get(slug, parentId)
      return row ? camelizeRow(row) : null
    },

    /** Direct children, or the roots when no parent is given. */
    children(parentId = null) {
      return camelizeRows(selectChildren.all(parentId))
    },

    /**
     * Everything strictly below a location, at any depth. A prefix match on the
     * materialised path, so this is one indexed range scan rather than a
     * recursive walk.
     */
    descendants(id) {
      return camelizeRows(selectDescendants.all(id, id))
    },

    /** Root first, so a breadcrumb can be rendered without reversing. */
    ancestors(id) {
      return camelizeRows(selectAncestors.all(id, id))
    },

    /**
     * Every active location, shallowest first.
     *
     * Ordered by depth then name rather than by name alone, so the unfiltered
     * listing is already a hierarchy and a client can render a breadcrumb or a
     * cascading dropdown from a single page without re-sorting.
     */
    list({ limit = REFERENCE_PAGE_SIZE, offset = 0 } = {}) {
      const page = normalisePagination({ limit, offset })
      return {
        items: camelizeRows(selectAll.all(page.limit, page.offset)),
        total: countActive.get().total,
      }
    },

    /**
     * One level of the hierarchy.
     *
     * Returns the count for the whole level alongside the page, because a
     * location list filtered to `kind=ward` is exactly the request that needs a
     * total: a UI showing "142 wards" is the first thing anyone asks for.
     */
    listByKind(kind, { limit = REFERENCE_PAGE_SIZE, offset = 0 } = {}) {
      assertLocationKind(kind)
      const page = normalisePagination({ limit, offset })
      return {
        items: camelizeRows(selectByKind.all(kind, page.limit, page.offset)),
        total: countByKindTotal.get(kind).total,
      }
    },

    /** The same, as a bare array, for callers that only want the rows. */
    byKind(kind, page) {
      return listByKind(kind, page).items
    },

    counts() {
      const counts = Object.fromEntries(COVERAGE_LEVELS.map((level) => [level, 0]))
      for (const row of countByKind.all()) counts[row.kind] = row.total
      return counts
    },

    update(id, patch) {
      const current = requireLocation(id)
      if (patch.kind && patch.kind !== current.kind) {
        throw new ValidationError(
          'A location cannot change kind. Create a new location instead, so demand ' +
            'and supply recorded against the old kind stay valid.',
          { field: 'kind' },
        )
      }
      const name = patch.name ? String(patch.name).trim() : current.name
      const coordinates = validateCoordinates({
        latitude: patch.latitude === undefined ? current.latitude : patch.latitude,
        longitude: patch.longitude === undefined ? current.longitude : patch.longitude,
      })
      const slug = patch.slug ? slugify(patch.slug) : current.slug
      updateRow.run({
        id,
        name,
        slug,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        externalCode:
          patch.externalCode === undefined ? current.external_code : patch.externalCode,
        isActive:
          patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
        now: nowIso(),
      })
      // Every descendant carries this location's name in its own path_names, so a
      // rename has to reach the subtree or breadcrumbs start lying. The reference
      // tree is small, so one rebuild beats tracking which rows were touched.
      if (name !== current.name || slug !== current.slug) {
        repository.rebuildPaths()
      }
      return camelizeRow(selectById.get(id))
    },

    /**
     * Rebuilds every materialised path from the parent_id tree.
     *
     * The triggers in migration 002 maintain a single row on insert, rename and
     * re-parent, but a path is denormalised onto every descendant, so a rename
     * has to reach the whole subtree. Rather than doing string surgery on
     * `path_names` inside a trigger, the repository recomputes the paths. It is
     * one pass, it is idempotent, and it doubles as the repair hatch for a
     * reference import that rewrote half the tree.
     */
    rebuildPaths() {
      const rebuild = db.transaction(() => {
        for (const row of selectTree.all()) {
          writePath.run(row)
        }
      })
      rebuild()
      return true
    },

    /**
     * Records the provenance of a reference import. Reference data is real-world
     * data that arrives from outside, and being able to say which revision of
     * which dataset a row came from is what makes it re-importable.
     */
    recordReferenceSource({
      id,
      name,
      kind,
      version,
      sourceUri = null,
      licence = null,
      rowCount = 0,
      notes = null,
    }) {
      upsertSource.run({
        id,
        name,
        kind,
        version,
        sourceUri,
        licence,
        rowCount,
        notes,
      })
    },

    /**
     * Resolves the location a demand or supply record is attributed to.
     *
     * A search scoped to a ward rolls up to whichever coverage level was asked
     * for, so a district total and a ward total are computed from the same
     * events rather than from two interpretations of the same search. When the
     * requested level does not exist above the given location, the location's own
     * kind is used rather than inventing a level the data cannot support.
     */
    coverageLocation(locationId, level) {
      if (!locationId) return { locationId: null, coverageLevel: null }
      assertCoverageLevel(level)
      const target = requireLocation(locationId)
      if (target.kind === level) {
        return { locationId: target.id, coverageLevel: level }
      }
      const match = selectAncestors.all(locationId, locationId).find((row) => row.kind === level)
      return {
        locationId: match ? match.id : target.id,
        coverageLevel: match ? level : target.kind,
      }
    },

    /**
     * Find-or-create down a path, for the seed and import tooling.
     *
     * Each segment may be a plain name or an object carrying kind and external
     * code, so a caller that has the authoritative dataset can import it in one
     * pass without a separate existence check per level.
     */
    ensureByPath(segments) {
      let parentId = null
      let node = null
      for (const segment of segments) {
        const name = typeof segment === 'string' ? segment : segment.name
        node = selectBySlug.get(slugify(name), parentId)
        if (!node) {
          const created = repository.create({
            kind: typeof segment === 'string' ? 'district' : (segment.kind ?? 'district'),
            name,
            parentId,
            externalCode: typeof segment === 'string' ? null : segment.externalCode,
            latitude: typeof segment === 'string' ? null : segment.latitude,
            longitude: typeof segment === 'string' ? null : segment.longitude,
            sourceId: typeof segment === 'string' ? null : segment.sourceId,
          })
          node = selectById.get(created.id)
        }
        parentId = node.id
      }
      return camelizeRow(node)
    },
  }

  return repository
}
