import { newId, slugify } from '../../core/identifiers.js'
import {
  normaliseSkillName,
  skillSlug,
  CATEGORY_ROOTS,
} from '../../core/taxonomy.js'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js'
import {
  camelizeRow,
  camelizeRows,
  camelizeJsonRows,
  nowIso,
  parseJson,
  toJson,
} from '../mapping.js'
import { normalisePagination, likeParam } from './common.js'

/**
 * Categories and skills.
 *
 * Two separate trees, for the reason given in src/core/taxonomy.js: a category
 * answers "what kind of thing is this" and a skill answers "what can this person
 * do". The repository keeps them apart and exposes a mapping between them rather
 * than pretending the distinction can be collapsed.
 */

const CATEGORY_COLUMNS = `
  id, parent_id, name, slug, description, icon, sort_weight, vertical,
  is_active, source_id, path_slugs, created_at, updated_at
`

const SKILL_COLUMNS = `
  id, name, slug, synonyms, vertical, source_id, created_at, updated_at
`

export function createCategoriesRepository(db) {
  const insert = db.prepare(
    `INSERT INTO category (
       id, parent_id, name, slug, description, icon, sort_weight, vertical, source_id
     ) VALUES (
       @id, @parentId, @name, @slug, @description, @icon, @sortWeight, @vertical, @sourceId
     )`,
  )
  const selectById = db.prepare(`SELECT ${CATEGORY_COLUMNS} FROM category WHERE id = ?`)
  const selectBySlug = db.prepare(
    `SELECT ${CATEGORY_COLUMNS} FROM category WHERE slug = ? AND parent_id IS ?`,
  )
  const selectChildren = db.prepare(
    `SELECT ${CATEGORY_COLUMNS} FROM category
      WHERE parent_id IS ? AND is_active = 1
      ORDER BY sort_weight ASC, name ASC`,
  )
  const selectAll = db.prepare(
    `SELECT ${CATEGORY_COLUMNS} FROM category WHERE is_active = 1
      ORDER BY depth ASC, sort_weight ASC, name ASC`,
  )
  // path_slugs holds slugs, not ids, so a category id has to be resolved to its
  // own slug before it can be prefix-matched. Without that translation this
  // query silently returns nothing, which is worse than an error.
  const selectDescendants = db.prepare(
    `SELECT ${CATEGORY_COLUMNS} FROM category
      WHERE ('/' || path_slugs || '/') LIKE '%/' || ? || '/%'
        AND id <> ?
        AND is_active = 1
      ORDER BY depth ASC, sort_weight ASC, name ASC`,
  )
  const updateRow = db.prepare(
    `UPDATE category
        SET name = @name, description = @description, icon = @icon,
            sort_weight = @sortWeight, vertical = @vertical,
            is_active = @isActive, updated_at = @now
      WHERE id = @id`,
  )
  const linkSkill = db.prepare(
    `INSERT OR IGNORE INTO category_skill (category_id, skill_id) VALUES (?, ?)`,
  )
  const unlinkSkill = db.prepare(
    `DELETE FROM category_skill WHERE category_id = ? AND skill_id = ?`,
  )
  const selectSkills = db.prepare(
    `SELECT s.id, s.name, s.slug, s.synonyms, s.vertical
       FROM category_skill cs
       JOIN skill s ON s.id = cs.skill_id
      WHERE cs.category_id = ?
      ORDER BY s.name ASC`,
  )
  const countChildren = db.prepare(
    `SELECT COUNT(*) AS total FROM category WHERE parent_id = ? AND is_active = 1`,
  )

  function requireCategory(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Category', id)
    return row
  }

  return {
    create(input) {
      const name = String(input.name ?? '').trim()
      if (name.length < 2 || name.length > 120) {
        throw new ValidationError('A category name must be 2 to 120 characters.', {
          field: 'name',
        })
      }
      const parentId = input.parentId ?? null
      if (parentId) requireCategory(parentId)
      const slug = slugify(input.slug || name)
      if (selectBySlug.get(slug, parentId)) {
        throw new ConflictError(`A category named "${name}" already exists here.`, {
          slug,
          parentId,
        })
      }
      const id = newId()
      insert.run({
        id,
        parentId,
        name,
        slug,
        description: input.description ?? null,
        icon: input.icon ?? null,
        sortWeight: Number.isInteger(input.sortWeight) ? input.sortWeight : 1000,
        vertical: input.vertical ?? null,
        sourceId: input.sourceId ?? null,
      })
      return camelizeRow(selectById.get(id))
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? camelizeRow(row) : null
    },

    requireById(id) {
      return camelizeRow(requireCategory(id))
    },

    findBySlug(slug, parentId = null) {
      const row = selectBySlug.get(slug, parentId)
      return row ? camelizeRow(row) : null
    },

    children(parentId = null) {
      return camelizeRows(selectChildren.all(parentId))
    },

    all() {
      return camelizeRows(selectAll.all())
    },

    descendants(id) {
      const self = requireCategory(id)
      return camelizeRows(selectDescendants.all(self.slug, id))
    },

    /**
     * The category tree, nested, for the navigation menus.
     *
     * Built in one pass over the flat list rather than with a recursive query per
     * node, so rendering the whole menu is a single query no matter how deep the
     * taxonomy goes.
     */
    tree({ includeCounts = false } = {}) {
      const flat = selectAll.all()
      const nodes = new Map()
      for (const row of flat) {
        const node = camelizeRow(row)
        node.children = []
        // null, not 0. The count is opt-in, and a zero here is a claim: it says
        // this category has nothing in it, which is exactly what a category that
        // was never counted also used to say. A client that renders this field
        // without asking for counts would show a confident "0" beside a covered
        // market. Absent information has to look absent.
        node.businessCount = null
        nodes.set(row.id, node)
      }
      const roots = []
      for (const row of flat) {
        const node = nodes.get(row.id)
        const parent = row.parent_id ? nodes.get(row.parent_id) : null
        if (parent) parent.children.push(node)
        else roots.push(node)
      }
      if (includeCounts) this._attachCounts(roots)
      return roots
    },

    /**
     * Puts a published count on every node, rolled up the tree.
     *
     * `approved` and `active` are required here for the same reason they are
     * required in the search index: this number is what a client shows a user to
     * decide whether a market is covered, so counting records that nobody has
     * checked would promise coverage the directory does not have. An operator
     * who wants the queue size asks the review queue, which is a different
     * question and lives at a different path.
     */
    _attachCounts(roots) {
      const rows = db
        .prepare(
          `SELECT category_id, COUNT(*) AS total FROM business
            WHERE status = 'active' AND verification_state = 'approved'
            GROUP BY category_id`,
        )
        .all()
      const direct = new Map(rows.map((row) => [row.category_id, row.total]))
      // A node with no row of its own counts as zero here rather than staying
      // null, because at this point the count really is being computed and a
      // leaf with nothing against it is genuinely empty.
      const addUp = (node) => {
        let total = direct.get(node.id) ?? 0
        for (const child of node.children) total += addUp(child)
        node.businessCount = total
        return total
      }
      for (const root of roots) addUp(root)
    },

    update(id, patch) {
      const current = requireCategory(id)
      updateRow.run({
        id,
        name: patch.name ? String(patch.name).trim() : current.name,
        description:
          patch.description === undefined ? current.description : patch.description,
        icon: patch.icon === undefined ? current.icon : patch.icon,
        sortWeight:
          patch.sortWeight === undefined ? current.sort_weight : patch.sortWeight,
        vertical: patch.vertical === undefined ? current.vertical : patch.vertical,
        isActive:
          patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
        now: nowIso(),
      })
      return camelizeRow(selectById.get(id))
    },

    /**
     * A category with live children cannot be deleted, only deactivated. The
     * `ON DELETE RESTRICT` in the schema would catch it anyway, but failing with
     * a domain message is more useful than a constraint violation.
     */
    deactivate(id) {
      if (countChildren.get(id).total > 0) {
        throw new ConflictError(
          'This category still has sub-categories. Deactivate them first.',
          { id },
        )
      }
      return this.update(id, { isActive: false })
    },

    linkSkill(categoryId, skillId) {
      requireCategory(categoryId)
      linkSkill.run(categoryId, skillId)
      return this.skillsFor(categoryId)
    },

    unlinkSkill(categoryId, skillId) {
      unlinkSkill.run(categoryId, skillId)
      return this.skillsFor(categoryId)
    },

    skillsFor(categoryId) {
      return camelizeJsonRows(selectSkills.all(categoryId), ['synonyms'])
    },

    /**
     * Creates the five root categories from core/taxonomy.js.
     *
     * The roots are declared in code rather than seeded from a fixture so that a
     * fresh database always has the same top-level navigation, and so that the
     * declaration is reviewable in the same diff as the rules that depend on it.
     */
    ensureRoots() {
      const created = []
      const addRoots = db.transaction(() => {
        for (const [index, root] of CATEGORY_ROOTS.entries()) {
          const existing = selectBySlug.get(root.slug, null)
          if (existing) {
            created.push(camelizeRow(existing))
            continue
          }
          insert.run({
            id: newId(),
            parentId: null,
            name: root.name,
            slug: root.slug,
            description: root.description,
            icon: null,
            sortWeight: (index + 1) * 10,
            vertical: null,
            sourceId: 'core:CATEGORY_ROOTS',
          })
          created.push(camelizeRow(selectBySlug.get(root.slug, null)))
        }
      })
      addRoots()
      return created
    },
  }
}

export function createSkillsRepository(db) {
  const insert = db.prepare(
    `INSERT INTO skill (id, name, slug, synonyms, vertical, source_id)
     VALUES (@id, @name, @slug, @synonyms, @vertical, @sourceId)`,
  )
  const selectById = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skill WHERE id = ?`)
  const selectBySlug = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skill WHERE slug = ?`)
  const selectByName = db.prepare(
    `SELECT ${SKILL_COLUMNS} FROM skill WHERE name = ? COLLATE NOCASE`,
  )
  const selectAll = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skill ORDER BY name ASC`)
  const search = db.prepare(
    `SELECT ${SKILL_COLUMNS} FROM skill
      WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
         OR slug LIKE ? ESCAPE '\\'
      ORDER BY name ASC
      LIMIT ? OFFSET ?`,
  )
  const selectSynonyms = db.prepare(
    `SELECT ${SKILL_COLUMNS} FROM skill WHERE synonyms LIKE ? ESCAPE '\\'`,
  )
  const updateRow = db.prepare(
    `UPDATE skill SET name = @name, synonyms = @synonyms, vertical = @vertical, updated_at = @now
      WHERE id = @id`,
  )

  return {
    /**
     * Skills are an open vocabulary, so this is a find-or-create keyed on the
     * slug. Two people typing "laptop repair" and "Laptop Repair" get the same
     * skill row, which is the only way the supply count for a skill means
     * anything.
     */
    findOrCreate(name, { vertical = null, sourceId = null } = {}) {
      const clean = normaliseSkillName(name)
      const slug = skillSlug(clean)
      const existing = selectBySlug.get(slug) ?? selectByName.get(clean)
      if (existing) return camelizeJsonRow(existing)

      const id = newId()
      insert.run({
        id,
        name: clean,
        slug,
        synonyms: toJson([]),
        vertical,
        sourceId,
      })
      return camelizeJsonRow(selectById.get(id))
    },

    findById(id) {
      const row = selectById.get(id)
      return row ? camelizeJsonRow(row) : null
    },

    findBySlug(slug) {
      const row = selectBySlug.get(slug)
      return row ? camelizeJsonRow(row) : null
    },

    all() {
      return camelizeJsonRows(selectAll.all(), ['synonyms'])
    },

    query({ term, limit = 25, offset = 0 } = {}) {
      const page = normalisePagination({ limit, offset })
      const pattern = term ? likeParam(term) : '%'
      return camelizeJsonRows(search.all(pattern, pattern, page.limit, page.offset), [
        'synonyms',
      ])
    },

    /**
     * Skills whose synonym list mentions a term. Used by the demand engine to
     * map a searched phrase onto a skill, so "laptop fix" and "laptop repair"
     * reach the same supply measurement.
     */
    bySynonym(term) {
      return camelizeJsonRows(
        selectSynonyms.all(`%"${String(term).toLowerCase()}"%`),
        ['synonyms'],
      )
    },

    update(id, patch) {
      const row = selectById.get(id)
      if (!row) throw new NotFoundError('Skill', id)
      updateRow.run({
        id,
        name: patch.name ? normaliseSkillName(patch.name) : row.name,
        synonyms: toJson(patch.synonyms ?? parseJson(row.synonyms, [])),
        vertical: patch.vertical === undefined ? row.vertical : patch.vertical,
        now: nowIso(),
      })
      return camelizeJsonRow(selectById.get(id))
    },

    count() {
      return selectAll.all().length
    },
  }
}

function camelizeJsonRow(row) {
  const record = camelizeRow(row)
  record.synonyms = parseJson(record.synonyms, [])
  return record
}
