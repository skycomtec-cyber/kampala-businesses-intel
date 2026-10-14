import { ValidationError } from './errors.js'

/**
 * Business photographs.
 *
 * The rules for what a photo is made of: which image formats are accepted, how a
 * caller's upload is turned into bytes, and what part of a stored row the public
 * is allowed to see. Kept pure so a test can hand it a fixed byte string and read
 * the same decision the api would.
 *
 * The one rule that matters is that the format is decided by the bytes, never by
 * the caller. A data url carries a declaration — `data:image/png;base64,...` — and
 * a declaration is exactly the thing an attacker controls, so the header is used
 * only to reject early and the magic bytes are what actually decides. The `mime`
 * this module returns is the sniffed one, and it is the only one that is stored.
 *
 * Like reviews, there is no stored "is public" judgement here and none in the
 * repository: a photo is pending when it arrives, and a recorded decision is the
 * only way it becomes something the directory shows. And like reviews there is no
 * scanning for objectionable content in code — the human decision in the path is
 * the moderation step, and a list of forbidden pixels would only be a worse
 * version of it.
 */

/** The formats a browser renders as an image and this platform will store. */
export const PHOTO_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])

export const PHOTO_STATUSES = Object.freeze(['pending', 'published', 'rejected'])

export const PHOTO_SOURCES = Object.freeze(['provider', 'admin', 'api', 'import'])

/** The two things a moderator can decide about a pending photo. */
export const PHOTO_DECISIONS = Object.freeze({
  publish: 'published',
  reject: 'rejected',
})

export function isPhotoStatus(status) {
  return PHOTO_STATUSES.includes(status)
}

/**
 * Ceiling on the decoded image, not on the request.
 *
 * Four megabytes is generous for a phone photo exported for the web and far below
 * the point where a gallery becomes a storage problem. The transport ceiling is
 * separate and larger (config.api.photoBodyLimit) because base64 inflates the
 * bytes by about a third, and a caller should be refused for the picture being
 * too big, not for the encoding of it.
 */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024

export const CAPTION_MAX = 300
export const ALT_TEXT_MAX = 300
export const REASON_MAX = 500

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

/** PNG's eight-byte signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The image format of a buffer, from its bytes alone, or null.
 *
 * A JPEG starts with FF D8 FF. A PNG starts with its signature. A WebP is a RIFF
 * container whose form type is "WEBP" — "RIFF" at byte 0, the four-byte size, then
 * "WEBP" at byte 8. Each check is a fixed offset, so this reads no further into
 * the file than it has to and cannot be fooled by content later in it.
 */
export function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export function extensionForMime(mime) {
  return MIME_EXTENSIONS[mime] ?? null
}

const DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i

/**
 * Turns a submitted data url into validated image bytes.
 *
 * The declared type is checked against the accepted set first, because a caller
 * uploading a PDF as a photo has made a mistake worth naming, and only then are
 * the bytes decoded and sniffed. The sniffed type is what is returned; a declared
 * PNG whose bytes are a JPEG is stored as a JPEG rather than refused, because the
 * mismatch is a broken client rather than an attack once the bytes themselves are
 * known to be an accepted image.
 *
 * A non-image, a truncated payload, an oversized image, or a data url with no
 * base64 body all raise ValidationError, so the api layer answers 400 with a
 * sentence rather than 500 from a downstream surprise.
 */
export function decodeImageDataUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('A photo must be sent as a base64 data url.', { field: 'data' })
  }
  const match = DATA_URL_PATTERN.exec(value.trim())
  if (!match) {
    throw new ValidationError('A photo must be an image data url of the form data:image/...;base64,...', {
      field: 'data',
      allowed: PHOTO_MIME_TYPES,
    })
  }
  const declared = match[1].toLowerCase()
  if (!PHOTO_MIME_TYPES.includes(declared)) {
    throw new ValidationError('Only JPEG, PNG and WebP images are accepted.', {
      field: 'data',
      allowed: PHOTO_MIME_TYPES,
    })
  }

  // Whitespace is legal inside base64 in a data url and is ignored by Buffer's
  // decoder, but it is removed here so the size check measures the payload.
  const compact = match[2].replace(/\s+/g, '')
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0) {
    throw new ValidationError('The photo data url contains no image.', { field: 'data' })
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new ValidationError(
      `A photo must be at most ${Math.floor(MAX_PHOTO_BYTES / (1024 * 1024))} MB.`,
      { field: 'data', maxBytes: MAX_PHOTO_BYTES },
    )
  }

  const mime = sniffImageMime(bytes)
  if (!mime) {
    throw new ValidationError('Those bytes are not a JPEG, PNG or WebP image.', {
      field: 'data',
      allowed: PHOTO_MIME_TYPES,
    })
  }
  return { mime, bytes, extension: extensionForMime(mime) }
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
 * A photo upload: the bytes and the words that describe them.
 *
 * Caption and alt text are both optional and are the owner's to write. Nothing
 * about the binary is accepted from the caller — not the size, not the type, not
 * the extension — because all three are read from the bytes in
 * `decodeImageDataUrl`.
 */
export function buildPhotoUpload(input = {}) {
  const data = input.data ?? input.image ?? input.photo
  const decoded = decodeImageDataUrl(data)
  return {
    mimeType: decoded.mime,
    bytes: decoded.bytes,
    extension: decoded.extension,
    caption: cleanText(input.caption, { field: 'caption', max: CAPTION_MAX }),
    altText: cleanText(input.altText ?? input.alt, { field: 'altText', max: ALT_TEXT_MAX }),
  }
}

/**
 * A moderation decision on a photo, which is a status and a reason.
 *
 * Same rule as a review's: the decision is the moment a picture becomes something
 * the directory asserts about a business, and the reason is the only part of that
 * anyone reads later, so it is required for both outcomes.
 */
export function buildModerationDecision({ decision, status, reason } = {}) {
  const requested = status ?? (decision ? PHOTO_DECISIONS[decision] : null)
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
 * The shape a caller without moderation rights is allowed to see.
 *
 * `storageKey` is dropped because the path on disk is not a fact about the
 * business; the public addresses a photo through its content route, by id. The
 * moderator's reason and the account that uploaded it are dropped for the same
 * reason a review's are: they are notes to the operation, not facts about the
 * picture, and a field that is present and empty is one a client renders as
 * "withheld". `businessName` and `businessSlug` are administrative joins, so they
 * go too.
 */
export function publicPhoto(row) {
  if (!row) return null
  const {
    storageKey,
    uploadedBy,
    reviewerId,
    moderationReason,
    businessName,
    businessSlug,
    ...rest
  } = row
  return rest
}
