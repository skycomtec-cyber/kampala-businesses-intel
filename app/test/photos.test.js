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
  PHOTO_MIME_TYPES,
  MAX_PHOTO_BYTES,
  sniffImageMime,
  decodeImageDataUrl,
  buildPhotoUpload,
  buildModerationDecision,
  publicPhoto,
} from '../src/core/photos.js'

/**
 * Business photographs.
 *
 * The gallery repeats the review feature's central rule — nothing is public until
 * a moderator says so — and adds one of its own: the format of an image is decided
 * by its bytes, never by what the caller declared. Both are checked here, the
 * first through the api because that is where it can be broken, the second on the
 * pure functions because that is where it is enforced.
 *
 * The images are the smallest byte strings that carry the right magic number. The
 * sniffing rule reads a header and nothing more, so a real photograph would test
 * the same branch with twenty times the storage.
 */

const PASSWORD = 'Kampala-Reference-2026'
const PROVIDER_PASSWORD = 'Provider-Self-Service-2026'

// The shortest buffers that are unambiguously each format, padded past the
// twelve-byte minimum the sniffer reads.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9, 2)])
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(4, 3),
])

const dataUrl = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`

async function freshServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-photos-'))
  const config = loadConfig({ dataDir: dir, databaseFile: path.join(dir, 'photos.db') })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  const server = await buildApi({ app, config, logger: false, web: false })
  return {
    app,
    server,
    config,
    dir,
    async cleanup() {
      await server.close()
      app.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function signIn(ctx, { email, role = 'admin' }) {
  ctx.app.users.create({ email, password: PASSWORD, displayName: 'Gallery Editor', role })
  const response = await ctx.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  })
  assert.equal(response.statusCode, 200, response.body)
  return { authorization: `Bearer ${response.json().data.token}` }
}

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

async function upload(ctx, headers, businessId, payload) {
  return ctx.server.inject({
    method: 'POST',
    url: `/api/v1/provider/businesses/${businessId}/photos`,
    headers,
    payload,
  })
}

/* --- the rules --------------------------------------------------------------- */

test('the format is read from the bytes, not from the declaration', () => {
  assert.deepEqual(PHOTO_MIME_TYPES, ['image/jpeg', 'image/png', 'image/webp'])
  assert.equal(sniffImageMime(PNG), 'image/png')
  assert.equal(sniffImageMime(JPEG), 'image/jpeg')
  assert.equal(sniffImageMime(WEBP), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('this is just text, no image here')), null)
  assert.equal(sniffImageMime(Buffer.alloc(4)), null)
  assert.equal(sniffImageMime('not a buffer'), null)
})

test('a data url is decoded and its true type wins over what it claims', () => {
  const decoded = decodeImageDataUrl(dataUrl('image/png', PNG))
  assert.equal(decoded.mime, 'image/png')
  assert.equal(decoded.extension, 'png')
  assert.ok(decoded.bytes.equals(PNG))

  // Declared a PNG, actually a JPEG: the bytes are accepted and are what is
  // stored, so a broken client cannot choose the served content type.
  const mistaken = decodeImageDataUrl(dataUrl('image/png', JPEG))
  assert.equal(mistaken.mime, 'image/jpeg')
  assert.equal(mistaken.extension, 'jpg')

  assert.throws(() => decodeImageDataUrl('data:image/gif;base64,R0lGOD'), /JPEG, PNG and WebP/)
  assert.throws(() => decodeImageDataUrl('not-a-data-url'), /data url/)
  assert.throws(() => decodeImageDataUrl(dataUrl('image/png', Buffer.from('plain text here'))), /JPEG, PNG or WebP/)
})

test('an upload carries the words, and the rules for them', () => {
  const upload_ = buildPhotoUpload({ data: dataUrl('image/webp', WEBP), caption: '  Shopfront  ', alt: 'Front door' })
  assert.equal(upload_.mimeType, 'image/webp')
  assert.equal(upload_.caption, 'Shopfront')
  assert.equal(upload_.altText, 'Front door')
  assert.equal(upload_.extension, 'webp')

  assert.throws(() => buildPhotoUpload({}), /data url/)
  assert.throws(
    () => buildPhotoUpload({ data: dataUrl('image/png', PNG), caption: 'x'.repeat(301) }),
    /at most 300 characters/,
  )
})

test('a decision is to publish or to reject, and always says why', () => {
  assert.equal(buildModerationDecision({ decision: 'publish', reason: 'Clear photo.' }).status, 'published')
  assert.equal(buildModerationDecision({ status: 'rejected', reason: 'Blurry.' }).status, 'rejected')
  assert.throws(() => buildModerationDecision({ decision: 'publish' }), /reason is required/)
  assert.throws(() => buildModerationDecision({ decision: 'feature', reason: 'Nice.' }), /publish or to reject/)
})

test('the public shape hides the storage path and the moderation note', () => {
  const shown = publicPhoto({
    id: 'p1',
    businessId: 'b1',
    storageKey: 'p1.png',
    mimeType: 'image/png',
    caption: 'Shopfront',
    status: 'published',
    uploadedBy: 'u1',
    reviewerId: 'u2',
    moderationReason: 'Clear.',
    businessName: 'Bukoto Hardware',
    businessSlug: 'bukoto-hardware',
  })
  assert.deepEqual(shown, {
    id: 'p1',
    businessId: 'b1',
    mimeType: 'image/png',
    caption: 'Shopfront',
    status: 'published',
  })
  assert.equal(publicPhoto(null), null)
})

/* --- the api ----------------------------------------------------------------- */

test('a photo is held for moderation, then served once published', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)

    const created = await upload(ctx, provider, business.id, {
      data: dataUrl('image/png', PNG),
      caption: 'The shopfront',
    })
    assert.equal(created.statusCode, 201, created.body)
    const photo = created.json().data
    assert.equal(photo.status, 'pending')
    assert.equal(created.json().meta.moderation, 'pending')
    // The path on disk is an implementation detail and never leaves the api.
    assert.equal('storageKey' in photo, false)
    assert.equal('uploadedBy' in photo, false)

    // Pending: absent from the public gallery, and its bytes are not served.
    const publicList = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/businesses/${business.slug}/photos`,
    })
    assert.equal(publicList.statusCode, 200, publicList.body)
    assert.equal(publicList.json().meta.total, 0)

    const anonymousFetch = await ctx.server.inject({ method: 'GET', url: photo.url })
    assert.equal(anonymousFetch.statusCode, 404, anonymousFetch.body)
    // But the owner can preview it before it is live.
    const ownerPreview = await ctx.server.inject({ method: 'GET', url: photo.url, headers: provider })
    assert.equal(ownerPreview.statusCode, 200, ownerPreview.body)

    // The queue shows the pending photo, storage key and all, to a moderator.
    const queue = await ctx.server.inject({ method: 'GET', url: '/api/v1/admin/photos?status=pending', headers: admin })
    assert.equal(queue.statusCode, 200, queue.body)
    const held = queue.json().data.find((row) => row.id === photo.id)
    assert.ok(held, 'the pending photo is in the queue')
    assert.equal(held.businessSlug, business.slug)
    assert.equal(typeof held.storageKey, 'string')

    const published = await ctx.server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/photos/${photo.id}`,
      headers: admin,
      payload: { decision: 'publish', reason: 'A clear photo of the shop.' },
    })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().data.status, 'published')

    // Now public, on the gallery, and its bytes come back as an image.
    const after = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}/photos` })
    assert.equal(after.json().meta.total, 1)
    const shown = after.json().data[0]
    assert.equal(shown.caption, 'The shopfront')
    assert.equal('storageKey' in shown, false)

    const bytes = await ctx.server.inject({ method: 'GET', url: shown.url })
    assert.equal(bytes.statusCode, 200)
    assert.match(bytes.headers['content-type'], /^image\/png/)
    assert.ok(bytes.rawPayload.equals(PNG))
  } finally {
    await ctx.cleanup()
  }
})

test('a rejection takes a photo out of the gallery, and deletion removes the file', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)

    const first = (await upload(ctx, provider, business.id, { data: dataUrl('image/jpeg', JPEG) })).json().data
    const second = (await upload(ctx, provider, business.id, { data: dataUrl('image/webp', WEBP) })).json().data

    for (const photo of [first, second]) {
      await ctx.server.inject({
        method: 'PATCH',
        url: `/api/v1/admin/photos/${photo.id}`,
        headers: admin,
        payload: { decision: 'publish', reason: 'Looks like the real premises.' },
      })
    }

    let gallery = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}/photos` })
    assert.equal(gallery.json().meta.total, 2)

    // Rejecting one removes it from the gallery and stops serving its bytes.
    const rejected = await ctx.server.inject({
      method: 'PATCH',
      url: `/api/v1/admin/photos/${first.id}`,
      headers: admin,
      payload: { decision: 'reject', reason: 'It is a stock photo, not the shop.' },
    })
    assert.equal(rejected.statusCode, 200, rejected.body)
    assert.equal(rejected.json().data.status, 'rejected')

    gallery = await ctx.server.inject({ method: 'GET', url: `/api/v1/businesses/${business.slug}/photos` })
    assert.equal(gallery.json().meta.total, 1)
    const notServed = await ctx.server.inject({ method: 'GET', url: first.url })
    assert.equal(notServed.statusCode, 404)

    // Deleting the other removes the row and the bytes behind it.
    const adminList = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/admin/photos?status=published',
      headers: admin,
    })
    const storedKey = adminList.json().data.find((row) => row.id === second.id).storageKey
    const storedFile = path.join(ctx.config.mediaDir, storedKey)
    assert.equal(fs.existsSync(storedFile), true)

    const removed = await ctx.server.inject({
      method: 'DELETE',
      url: `/api/v1/admin/photos/${second.id}`,
      headers: admin,
    })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.equal(removed.json().data.removed, true)
    assert.equal(fs.existsSync(storedFile), false)

    const gone = await ctx.server.inject({ method: 'GET', url: second.url })
    assert.equal(gone.statusCode, 404)
  } finally {
    await ctx.cleanup()
  }
})

test('only the owner may manage a listing\'s photos, and only a public listing has any', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)
    const other = await makePublished(ctx, admin, 'Elsewhere Enterprises')
    const otherProvider = await makeProvider(ctx, other, { email: 'other@example.com' })

    const intrude = await upload(ctx, otherProvider, business.id, { data: dataUrl('image/png', PNG) })
    assert.equal(intrude.statusCode, 403, intrude.body)

    const anonymous = await ctx.server.inject({
      method: 'POST',
      url: `/api/v1/provider/businesses/${business.id}/photos`,
      payload: { data: dataUrl('image/png', PNG) },
    })
    assert.equal(anonymous.statusCode, 401, anonymous.body)

    // A draft listing has no public gallery at all.
    const [district] = ctx.app.locations.byKind('district')
    const root = ctx.app.categories.ensureRoots()[1]
    const category = ctx.app.categories.children(root.id)[0]
    const draft = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/businesses',
      headers: admin,
      payload: { name: 'Not Yet Listed', categoryId: category.id, locationId: district.id, status: 'active' },
    })
    const draftPhotos = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/businesses/${draft.json().data.slug}/photos`,
    })
    assert.equal(draftPhotos.statusCode, 404, draftPhotos.body)
  } finally {
    await ctx.cleanup()
  }
})

test('a bad upload is refused before it reaches the media directory', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)

    const notAnImage = await upload(ctx, provider, business.id, { data: dataUrl('image/png', Buffer.from('definitely not a picture')) })
    assert.equal(notAnImage.statusCode, 400, notAnImage.body)

    const wrongType = await upload(ctx, provider, business.id, { data: 'data:application/pdf;base64,JVBERi0=' })
    assert.equal(wrongType.statusCode, 400, wrongType.body)

    const missing = await upload(ctx, provider, business.id, { caption: 'No data' })
    assert.equal(missing.statusCode, 400, missing.body)

    // Nothing was written for any of the refused requests.
    assert.equal(fs.existsSync(ctx.config.mediaDir) ? fs.readdirSync(ctx.config.mediaDir).length : 0, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('photo uploads are rate limited, and the ceiling is the decoded size', async () => {
  const ctx = await freshServer()
  try {
    const admin = await signIn(ctx, { email: 'admin@kip.test' })
    const business = await makePublished(ctx, admin)
    const provider = await makeProvider(ctx, business)

    assert.equal(MAX_PHOTO_BYTES, 4 * 1024 * 1024)

    for (let i = 0; i < 30; i += 1) {
      const response = await upload(ctx, provider, business.id, { data: dataUrl('image/png', PNG) })
      assert.equal(response.statusCode, 201, response.body)
    }
    const blocked = await upload(ctx, provider, business.id, { data: dataUrl('image/png', PNG) })
    assert.equal(blocked.statusCode, 429, blocked.body)
    assert.equal(Number(blocked.headers['x-ratelimit-limit']), 30)
  } finally {
    await ctx.cleanup()
  }
})
