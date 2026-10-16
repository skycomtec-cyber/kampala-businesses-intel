import fs from 'node:fs'
import path from 'node:path'

import { HarvestError } from '../core/errors.js'

/**
 * A transport that reads saved pages from a local directory.
 *
 * Offline mode is not a test-only convenience: the two registered sources have
 * local website mirrors, so a harvest against those mirrors is how an operator
 * actually re-populates the catalogue without pulling down the live site. The
 * mirror path is taken from the page's `mirror` field, or falls back to the
 * last segment of the page URL.
 */
export function localDirTransport(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('localDirTransport requires a non-empty root directory.')
  }
  const rootDir = path.resolve(root)
  return {
    async read(page) {
      let relative = page.mirror
      if (!relative || relative.trim() === '') {
        try {
          const url = new URL(page.url)
          const parts = url.pathname.split('/').filter(Boolean)
          relative = parts.length === 0 ? 'index.html' : parts[parts.length - 1]
        } catch {
          relative = path.basename(String(page.url))
        }
      }
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
