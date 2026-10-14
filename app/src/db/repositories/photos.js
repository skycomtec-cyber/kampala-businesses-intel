import { newId } from '../../core/identifiers.js'
import { buildModerationDecision } from '../../core/photos.js'
import { NotFoundError } from '../../core/errors.js'
import { camelizeRow, nowIso } from '../mapping.js'
import { normalisePagination, where, resolveOrder } from './common.js'

/**
 * Business photographs.
 *
 * The database half of the gallery. The bytes never pass through here — the
 * `storageKey` column names a file the media store owns — so this repository is
 * small and stays that way: a photo is a row of metadata whose only interesting
 * transition is the moderation decision.
 *
 * As with reviews, there is no argument to `create` that makes a photo public.
 * A submission is written `pending`, and `moderate` is the only method that can
 * move it into or out of `published`, so the "nothing is shown until a human says
 * so" rule is enforced in one place rather than at every call site.
 *
 * `remove` returns the deleted row rather than a boolean, because the caller has
 * to delete the file the row pointed at and that is the last moment the key is
 * known. Returning a boolean would force every caller to read the row first, which
 * is a race the repository can simply avoid.
 */

const PHOTO_COLUMNS = `
  p.id, p.business_id, p.storage_key, p.mime_type, p.byte_size, p.caption,
  p.alt_text, p.position, p.status, p.source, p.uploaded_by, p.reviewer_id,
  p.moderation_reason, p.moderated_at, p.created_at, p.updated_at
`

const PHOTO_JOIN = `
  FROM business_photo p
  JOIN business b ON b.id = p.business_id
`

const ADMIN_PHOTO_COLUMNS = `${PHOTO_COLUMNS}, b.name AS business_name, b.slug AS business_slug`

const LIST_SORTS = Object.freeze({
  newest: 'p.created_at DESC',
  oldest: 'p.created_at ASC',
  position: 'p.position ASC',
})

export function createPhotosRepository(db) {
  const insert = db.prepare(
    `INSERT INTO business_photo (
       id, business_id, storage_key, mime_type, byte_size, caption, alt_text,
       position, status, source, uploaded_by
     ) VALUES (
       @id, @businessId, @storageKey, @mimeType, @byteSize, @caption, @altText,
       @position, @status, @source, @uploadedBy
     )`,
  )
  const selectById = db.prepare(`SELECT ${PHOTO_COLUMNS} FROM business_photo p WHERE p.id = ?`)
  const selectAdminById = db.prepare(
    `SELECT ${ADMIN_PHOTO_COLUMNS} ${PHOTO_JOIN} WHERE p.id = ?`,
  )
  const updateDecision = db.prepare(
    `UPDATE business_photo
        SET status = @status,
            reviewer_id = @reviewerId,
            moderation_reason = @reason,
            moderated_at = @moderatedAt,
            updated_at = @now
      WHERE id = @id`,
  )
  const updateFields = db.prepare(
    `UPDATE business_photo
        SET caption = @caption,
            alt_text = @altText,
            position = @position,
            updated_at = @now
      WHERE id = @id`,
  )
  const deleteById = db.prepare('DELETE FROM business_photo WHERE id = ?')
  const countByStatus = db.prepare(
    `SELECT status, COUNT(*) AS total FROM business_photo GROUP BY status`,
  )

  function requirePhoto(id) {
    const row = selectById.get(id)
    if (!row) throw new NotFoundError('Photo', id)
    return camelizeRow(row)
  }

  function page({ businessId = null, status = null, sort = 'newest', limit, offset }, { admin }) {
    const parsed = normalisePagination({ limit, offset })
    const conditions = []
    const params = { limit: parsed.limit, offset: parsed.offset }
    if (businessId) {
      conditions.push('p.business_id = @businessId')
      params.businessId = businessId
    }
    if (status) {
      conditions.push('p.status = @status')
      params.status = status
    }
    const clause = where(conditions)
    const order = resolveOrder(sort, LIST_SORTS, LIST_SORTS.newest)
    const columns = admin ? ADMIN_PHOTO_COLUMNS : PHOTO_COLUMNS
    const rows = db
      .prepare(
        `SELECT ${columns} ${PHOTO_JOIN} ${clause}
          ORDER BY ${order}, p.id ASC
          LIMIT @limit OFFSET @offset`,
      )
      .all(params)
    const total = db.prepare(`SELECT COUNT(*) AS total ${PHOTO_JOIN} ${clause}`).get(params).total
    return { items: rows.map(camelizeRow), total }
  }

  return {
    /**
     * Records a photo that has already been written to the media store.
     *
     * `storageKey` and the binary facts are passed in rather than derived, because
     * validation of the bytes belongs to the media/core boundary, not here. The
     * row is always `pending`.
     */
    create({
      businessId,
      storageKey,
      mimeType,
      byteSize,
      caption = null,
      altText = null,
      position = 0,
      source = 'provider',
      uploadedBy = null,
    }) {
      const id = newId()
      insert.run({
        id,
        businessId,
        storageKey,
        mimeType,
        byteSize,
        caption,
        altText,
        position,
        status: 'pending',
        source,
        uploadedBy: uploadedBy ?? null,
      })
      return requirePhoto(id)
    },

    /** The full row, storage key included. For the caller that must delete a file. */
    requireById(id) {
      return requirePhoto(id)
    },

    /** The moderation view of one photo, with the business it belongs to. */
    adminById(id) {
      const row = selectAdminById.get(id)
      if (!row) throw new NotFoundError('Photo', id)
      return camelizeRow(row)
    },

    /** A business's published photos, in the owner's order. */
    listPublished({ businessId, limit, offset, sort }) {
      return page({ businessId, status: 'published', sort: sort ?? 'position', limit, offset }, { admin: false })
    },

    /** Everything, for the moderation queue and the owner's desk. */
    list({ businessId, status, sort, limit, offset }) {
      return page({ businessId, status, sort, limit, offset }, { admin: true })
    },

    /** The only way in or out of the public gallery. */
    moderate(id, { status, decision, reason, reviewerId }) {
      const decisionValue = buildModerationDecision({ status, decision, reason })
      requirePhoto(id)
      updateDecision.run({
        id,
        status: decisionValue.status,
        reviewerId: reviewerId ?? null,
        reason: decisionValue.reason,
        moderatedAt: nowIso(),
        now: nowIso(),
      })
      return requirePhoto(id)
    },

    /**
     * Edits the words and the order of a photo. Deliberately cannot touch status:
     * an owner reordering their own gallery is not a moderation event.
     */
    update(id, patch = {}) {
      const current = requirePhoto(id)
      updateFields.run({
        id,
        caption: patch.caption !== undefined ? patch.caption : current.caption,
        altText: patch.altText !== undefined ? patch.altText : current.altText,
        position: patch.position !== undefined ? patch.position : current.position,
        now: nowIso(),
      })
      return requirePhoto(id)
    },

    /** Deletes a photo, returning the row that was removed (with its storage key). */
    remove(id) {
      const current = requirePhoto(id)
      deleteById.run(id)
      return current
    },

    counts() {
      return Object.fromEntries(countByStatus.all().map((row) => [row.status, row.total]))
    },
  }
}
