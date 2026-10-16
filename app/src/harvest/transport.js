import fs from 'node:fs'
import path from 'node:path'

import { HarvestError } from '../core/errors.js'

/**
 * A transport that reads saved pages from a local directory.
 *
 * Offline mode is not a test-only convenience: the registered sources have
 * local website mirrors, so a harvest against those mirrors is how an operator
 * actually re-populates the catalogue without pulling down the live site. The
 * mirror path is taken from the page's `mirror` field, or derived from the page
 * URL in the same host/path layout `writeMirror` produces, so a tree archived
 * by a live run replays as-is.
 */
export function localDirTransport(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('localDirTransport requires a non-empty root directory.')
  }
  const rootDir = path.resolve(root)
  return {
    async read(page) {
      const relative =
        page.mirror && page.mirror.trim() !== ''
          ? page.mirror
          : mirrorPathFor(page.url)
      const filePath = path.resolve(rootDir, relative)
      if (!filePath.startsWith(rootDir)) {
        throw new HarvestError(
          `The mirror path for ${page.url} resolves outside the root directory.`,
          { url: page.url, mirror: relative },
        )
      }
      if (!fs.existsSync(filePath)) {
        throw new HarvestError(`Page not found in mirror: ${page.url} (expected ${relative}).`, {
          url: page.url,
          mirror: relative,
        })
      }
      const body = fs.readFileSync(filePath, 'utf8')
      const now = new Date()
      return {
        status: 200,
        body,
        finalUrl: page.url,
        fetchedAt: now.toISOString(),
        headers: { 'content-type': 'text/html; charset=utf-8' },
        source: { type: 'local', root: rootDir, filePath },
      }
    },
  }
}

/**
 * The mirror layout for a page URL: a directory per host, then the URL's path.
 * Directory URLs and the site root become index.html. This is the layout
 * `localDirTransport` reads, so a run archived with `--mirror-out` can be
 * replayed with `--from-dir` without touching the plan. A port in the host
 * (e.g. "localhost:8080") is folded into the directory name because a colon is
 * not a legal path character on Windows.
 */
export function mirrorPathFor(pageUrl) {
  let url
  try {
    url = new URL(pageUrl)
  } catch {
    return path.basename(String(pageUrl))
  }
  const host = url.host.replaceAll(':', '_')
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length === 0) return path.posix.join(host, 'index.html')
  if (url.pathname.endsWith('/')) return path.posix.join(host, ...segments, 'index.html')
  return path.posix.join(host, ...segments)
}

/**
 * Writes a page body into a mirror tree, creating directories as needed, and
 * returns the path it wrote (relative to the root). The bytes are written
 * exactly as read, so the archived file hashes to the same SHA-256 the manifest
 * records for the live response.
 */
export function writeMirror(root, pageUrl, body) {
  const rootDir = path.resolve(root)
  const relative = mirrorPathFor(pageUrl)
  const filePath = path.resolve(rootDir, relative)
  if (!filePath.startsWith(rootDir + path.sep)) {
    throw new HarvestError(
      `The mirror path for ${pageUrl} resolves outside the root directory.`,
      { url: pageUrl, mirror: relative },
    )
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body, 'utf8')
  return relative
}

/**
 * A live HTTP transport using the global fetch.
 *
 * Polite by default: per-host delays, timeouts and bounded retries for
 * network/5xx failures. Robots.txt is deliberately not checked here (a local
 * mirror already respects what the operator archived), because a live harvest
 * should be used only when the operator explicitly accepts the source's terms.
 */
export function httpTransport({
  fetchImpl = globalThis.fetch,
  delayMs = 1000,
  timeoutMs = 20000,
  retries = 2,
  userAgent = 'Kampala-Intelligence-Harvest/1.0',
} = {}) {
  return {
    async read(page) {
      let lastError
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) {
          await sleep(delayMs)
        }
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), timeoutMs)
          const response = await fetchImpl(page.url, {
            signal: controller.signal,
            headers: {
              'user-agent': userAgent,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
          })
          clearTimeout(timeout)
          const body = await response.text()
          const now = new Date()
          if (response.status !== 200) {
            if (response.status >= 500 && attempt < retries) {
              lastError = new HarvestError(`Page ${page.url} returned ${response.status}.`)
              continue
            }
            throw new HarvestError(`Page ${page.url} returned ${response.status}.`, {
              status: response.status,
              url: page.url,
            })
          }
          return {
            status: response.status,
            body,
            finalUrl: response.url,
            fetchedAt: now.toISOString(),
            headers: Object.fromEntries(response.headers.entries()),
          }
        } catch (error) {
          lastError = error
          if (attempt === retries) break
          await sleep(delayMs)
        }
      }
      if (lastError instanceof HarvestError) throw lastError
      throw new HarvestError(
        `Failed to fetch ${page.url}: ${lastError?.message ?? 'network error'}.`,
        { url: page.url },
      )
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
