/**
 * The core layer.
 *
 * Contract for every other layer in the platform:
 *
 *   - No database, no HTTP, no filesystem, no clock, no randomness beyond
 *     crypto for identifiers. Everything here is a pure function of its inputs.
 *   - Nothing in this folder may import from `db`, `engine`, `api` or `web`.
 *
 * That constraint is what makes the engines reproducible. The same recorded
 * demand always produces the same gap score, which is what allows a gap
 * published six months ago to be recomputed and compared honestly.
 */

export * from './errors.js'
export * from './identifiers.js'
export * from './location.js'
export * from './taxonomy.js'
export * from './catalogue.js'
export * from './business.js'
export * from './secondLife.js'
export * from './ask.js'
export * from './demand.js'
export * from './intelligence.js'
export * from './privacy.js'
export * from './auth.js'
