/**
 * The harvest plan: where a source's records live, and how to read each field.
 *
 * A plan is data, not code. The alternative — a scraper per website — would mean
 * the extraction rules for a site live inside the platform's source tree, are
 * only changeable by a deploy, and cannot be reviewed as a diff of "this field
 * now comes from there instead". A plan is a small JSON file that says, for one
 * registered source, which pages to read and which rule to try, in order, for
 * each column of the batch it produces. It contains no records and no business
 * data, so publishing a plan reveals nothing a source's own website does not.
 *
 * The plan is validated before a single page is fetched. A plan that names no
 * source, lists no pages, or cannot fill the columns a listing cannot exist
 * without would otherwise fail slowly, one page at a time, producing a partial
 * batch on the way — and a partial batch is exactly the kind of file this whole
 * pipeline exists to make answerable.
 */

import { ValidationError } from '../core/errors.js'
import { IMPORT_COLUMNS } from '../import/rows.js'

/**
 * The columns a harvested record must be able to fill. Taken from the importer's
 * own contract rather than restated, so a plan cannot drift from the file format
 * the batch is written in.
 */
const REQUIRED_FIELDS = IMPORT_COLUMNS.required

/** The rule kinds a field may use. Anything else is a typo, not an extension. */
const RULE_KINDS = Object.freeze([
  'value', // a fixed value, e.g. the category every business on a site shares
  'jsonld', // a dotted path into the page's schema.org JSON-LD
  'og', // an OpenGraph meta property, e.g. "og:title"
  'meta', // a plain <meta name="..."> value
  'microdata', // an [itemprop="..."] value
  'selector', // a CSS selector; text, or an attribute when `attr` is set
  'page', // "url" or "path" of the page itself, for identity and evidence
])

/**
 * Parses and validates a plan.
 *
 * @param {object} raw the parsed JSON
 * @param {{ filename?: string }} [meta] where it came from, for error messages
 * @returns {object} a frozen, validated plan
 * @throws {ValidationError} naming the offending part of the plan
 */
export function definePlan(raw, { filename = null } = {}) {
  const where = filename ? `${filename}: ` : ''
  const fail = (message) => {
    throw new ValidationError(`${where}${message}`)
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('a plan must be a JSON object.')
  }

  if (typeof raw.sourceKey !== 'string' || raw.sourceKey.trim() === '') {
    fail('a plan must name the catalogue source it harvests (`sourceKey`).')
  }

  const pages = normalisePages(raw, fail)

  const fields = raw.fields
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    fail('a plan must define `fields`: a map of import column to a list of rules.')
  }

  for (const required of REQUIRED_FIELDS) {
    const rules = fields[required]
    if (!Array.isArray(rules) || rules.length === 0) {
      fail(`\`fields.${required}\` is required: a listing cannot exist without it.`)
    }
  }

  const known = new Set([...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional])
  for (const column of Object.keys(fields)) {
    if (!known.has(column)) {
      fail(`\`fields.${column}\` is not a column the importer accepts.`)
    }
    if (!Array.isArray(fields[column])) {
      fail(`\`fields.${column}\` must be a list of rules, tried in order.`)
    }
    for (const rule of fields[column]) assertRule(rule, `fields.${column}`, fail)
  }

  // Identity defaults to the page a record was read from, because for a harvest
  // the page *is* the reference: there is nothing more stable to key on, and it
  // is what a reviewer clicks to check the claim.
  const identity = fields.external_ref ? fields.external_ref : [{ page: 'url' }]

  return Object.freeze({
    sourceKey: raw.sourceKey.trim(),
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null,
    batchRef: typeof raw.batchRef === 'string' ? raw.batchRef : null,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
    pages: Object.freeze(pages),
    fields: Object.freeze(
      Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Object.freeze([...v])])),
    ),
    externalRef: Object.freeze([...identity]),
    filename,
  })
}

function normalisePages(raw, fail) {
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    fail('a plan must list at least one page to read (`pages`).')
  }
  return raw.pages.map((page, index) => {
    if (typeof page === 'string') return { url: page, ref: null }
    if (page === null || typeof page !== 'object') {
      fail(`\`pages[${index}]\` must be a url string or an object with a \`url\`.`)
    }
    if (typeof page.url !== 'string' || page.url.trim() === '') {
      fail(`\`pages[${index}]\` has no \`url\`.`)
    }
    return {
      url: page.url.trim(),
      // Where the same page lives inside a saved mirror, for an offline harvest.
      mirror: typeof page.mirror === 'string' ? page.mirror : null,
      // A short handle the rules can use when one site hosts several businesses.
      ref: typeof page.ref === 'string' ? page.ref : null,
      expected: page.expected ?? null,
    }
  })
}

function assertRule(rule, path, fail) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    fail(`\`${path}\` rules must be objects, e.g. { "selector": "h1" }.`)
  }
  const kinds = RULE_KINDS.filter((kind) => kind in rule)
  if (kinds.length === 0) {
    fail(`\`${path}\` has a rule with no kind. Use one of: ${RULE_KINDS.join(', ')}.`)
  }
  for (const kind of kinds) {
    if (typeof rule[kind] !== 'string' || rule[kind].trim() === '') {
      fail(`\`${path}\` has an empty \`${kind}\` rule.`)
    }
  }
  if (rule.all !== undefined && rule.all !== true) {
    fail(`\`${path}\` may only set \`all\` to true.`)
  }
  if (rule.attr !== undefined && typeof rule.attr !== 'string') {
    fail(`\`${path}\` \`attr\` must be an attribute name.`)
  }
}
