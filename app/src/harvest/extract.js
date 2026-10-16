import { load as cheerioLoad } from 'cheerio'

import { HarvestError } from '../core/errors.js'

/**
 * Extracts a record (a map of import column -> value) from an HTML page and a
 * set of field rules. Each field is an array of rules tried in order; the first
 * rule that returns a non-empty value wins.
 *
 * The order of evaluation is not accidental: structured data (JSON-LD) is the
 * least ambiguous; OpenGraph/meta tend to be present and canonical; CSS
 * selectors are a fallback for the sites that do not publish schema.org at all.
 * Each extracted value is trimmed, and any rule that specifies `stripPrefix`
 * removes a leading prefix (e.g. "tel:", "mailto:").
 */
export function extractRecord(html, rules, { page, plan } = {}) {
  const $ = cheerioLoad(html)

  const result = {}
  for (const [column, ruleList] of Object.entries(rules)) {
    const value = firstValue(html, $, ruleList, { page, plan, column })
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') result[column] = value
      else if (Array.isArray(value)) result[column] = value.join(', ')
      else result[column] = String(value)
    }
  }

  return result
}

function firstValue(html, $, rules, { page }) {
  for (const rule of rules) {
    const raw = getValue(html, $, rule, { page })
    if (raw === null || raw === undefined) continue
    let value = typeof raw === 'string' ? raw.trim() : raw
    if (value === '') continue
    if (rule.stripPrefix && typeof value === 'string') {
      const prefix = String(rule.stripPrefix)
      if (value.startsWith(prefix)) value = value.slice(prefix.length)
    }
    return value
  }
  return null
}

function getValue(html, $, rule, { page }) {
  // A fixed literal, possibly templated against the page's context.
  if (rule.value !== undefined) return template(String(rule.value), { page })

  // Special fields derived from the page itself.
  if (rule.page === 'url') return page?.url ?? null
  if (rule.page === 'path') {
    try {
      const url = new URL(page.url)
      return url.pathname
    } catch {
      return page?.url ?? null
    }
  }
  if (rule.page) return template(String(rule.page), { page })

  // JSON-LD: first match
  if (rule.jsonld) {
    const ld = extractJsonLd(html)
    if (ld) {
      const found = getByPath(ld, String(rule.jsonld))
      if (found !== undefined && found !== null) return found
    }
  }

  // OpenGraph
  if (rule.og) {
    const og = String(rule.og)
    const sel = $(`meta[property="${og}"], meta[name="${og}"]`).first()
    if (sel.length) return sel.attr('content') ?? sel.attr('value') ?? sel.text()
  }

  // Meta tags
  if (rule.meta) {
    const sel = $(`meta[name="${String(rule.meta)}"]`).first()
    if (sel.length) return sel.attr('content') ?? sel.attr('value') ?? sel.text()
  }

  // Microdata
  if (rule.microdata) {
    const sel = $(`[itemprop="${String(rule.microdata)}"]`).first()
    if (sel.length) return sel.attr('content') ?? sel.attr('href') ?? sel.text()
  }

  // CSS selector
  if (rule.selector) {
    const sel = rule.all ? $(String(rule.selector)) : $(String(rule.selector)).first()
    if (!sel || sel.length === 0) return null
    if (rule.all) {
      const values = sel
        .map((i, el) => {
          const node = $(el)
          if (rule.attr) return node.attr(String(rule.attr)) ?? ''
          return node.text() ?? ''
        })
        .get()
        .map((s) => String(s).trim())
        .filter(Boolean)
      return values.length === 0 ? null : values
    }
    if (rule.attr) return sel.attr(String(rule.attr)) ?? null
    return sel.text() ?? null
  }

  return null
}

function extractJsonLd(html) {
  const $ = cheerioLoad(html)
  const scripts = $('script[type="application/ld+json"]')
  for (let i = 0; i < scripts.length; i += 1) {
    const text = $(scripts[i]).text()
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        // Prefer an object that looks like an Organisation/LocalBusiness/Person
        const flat = parsed.find((x) => x && typeof x === 'object')
        if (flat) return flat
        continue
      }
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Ignore malformed blocks
    }
  }
  return null
}

function getByPath(obj, path) {
  if (!obj) return undefined
  const parts = String(path).split('.')
  let current = obj
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part]
    } else {
      return undefined
    }
  }
  if (current === undefined || current === null) return undefined
  if (typeof current === 'string') return current
  if (typeof current === 'number' || typeof current === 'boolean') return String(current)
  return current
}

function template(str, { page }) {
  return str
    .replaceAll('{url}', page?.url ?? '')
    .replaceAll('{ref}', page?.ref ?? '')
}
