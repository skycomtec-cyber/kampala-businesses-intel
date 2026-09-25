import { ValidationError } from './errors.js'
import { slugify } from './identifiers.js'

/**
 * The classification system.
 *
 * Categories and skills are two separate trees on purpose:
 *
 *  - A category answers "what kind of thing is this?" It is a closed
 *    navigational structure. Every business, service and product sits in
 *    exactly one category, and the category tree drives browsing, filtering
 *    and the supply side of gap analysis.
 *
 *  - A skill answers "what can this person do?" It is an open, many-to-many
 *    vocabulary. A business can have many skills, a skill can appear in any
 *    number of categories, and the same skill is what a service offering and a
 *    job seeker both declare.
 *
 * Collapsing these into one tree is the single most common way a business
 * directory ends up unsearchable, because a category tree cannot express
 * "electrician who also does solar installation in Wakiso".
 */

export const CATEGORY_ROOTS = Object.freeze([
  {
    slug: 'goods-and-products',
    name: 'Goods & Products',
    description: 'Physical items produced, imported, sold or resold.',
  },
  {
    slug: 'services',
    name: 'Services',
    description: 'Trades, professions and services offered to the public.',
  },
  {
    slug: 'skills-and-talent',
    name: 'Skills & Talent',
    description: 'Individual capabilities available for work or contract.',
  },
  {
    slug: 'second-life-electronics',
    name: 'Second Life Electronics',
    description:
      'Repair, refurbishment, resale, parts recovery and recycling of electronics. The first specialised vertical.',
  },
  {
    slug: 'places-and-premises',
    name: 'Places & Premises',
    description: 'Physical premises such as workshops, offices, markets and stores.',
  },
])

/**
 * Capability levels, from weakest to strongest signal of real coverage. Gap
 * scoring uses this to distinguish "one hobbyist listing this" from "an actual
 * cluster of providers".
 */
export const CAPABILITY_LEVELS = Object.freeze([
  'unverified',
  'claimed',
  'documented',
  'operating',
  'established',
])

export const CAPABILITY_RANK = Object.freeze(
  CAPABILITY_LEVELS.reduce((acc, level, index) => {
    acc[level] = index
    return acc
  }, {}),
)

export function assertCapabilityLevel(level) {
  if (!CAPABILITY_LEVELS.includes(level)) {
    throw new ValidationError(`Unknown capability level "${level}".`, {
      allowed: CAPABILITY_LEVELS,
    })
  }
  return level
}

/**
 * Ranking used to order sibling categories in navigation. Lower sorts first.
 * `null` weight means "sort alphabetically after everything weighted".
 */
export function compareCategorySort(a, b) {
  const aw = a.sortWeight ?? 1000
  const bw = b.sortWeight ?? 1000
  if (aw !== bw) return aw - bw
  return a.name.localeCompare(b.name)
}

export function normaliseSkillName(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('A skill name must be a string.')
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 2 || trimmed.length > 80) {
    throw new ValidationError('A skill name must be 2 to 80 characters.', {
      value: raw,
    })
  }
  return trimmed
}

export function skillSlug(name) {
  return slugify(normaliseSkillName(name))
}
