/**
 * Complete the provenance of the five web-imported listings.
 *
 * These records were written by the CSV importer, which fills the legacy free-text
 * `business.source_id` column with the source key. The controlled reference the
 * review pipeline actually reads, `business.catalogue_source_id`, was left null,
 * so "where did this come from" had no answer and no `record_provenance` row
 * existed for any of them. This script attaches both, using the same repository
 * call the HTTP handlers use, and adds the phone numbers the harvested pages
 * actually publish.
 *
 * It does not change any review state. Every listing stays in the queue, because
 * a provenance row says where a claim came from, not that the claim is true.
 *
 * Idempotent: `recordProvenance` upserts on (source, externalRef), and a contact
 * that is already present is skipped rather than duplicated. Running this twice is
 * expected to be harmless.
 */

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { canonicalContactValue } from '../src/core/business.js'
import { ConflictError } from '../src/core/errors.js'

/** When the harvested pages below were read off disk. */
const READ_ON = '2026-09-28'

/**
 * The shared Victoria View estate line, in each record's own notes. It is a
 * genuine number on both sites rather than a template artefact, so it is stored
 * twice rather than merged away, and the coincidence is written down where a
 * reviewer will read it.
 */
const SHARED_LINE_NOTE =
  'Also published by the other Victoria View Estate listing, so the two may share ' +
  'one estate management line. Treat as a possible duplicate until confirmed.'

const CLAIMS = [
  {
    slug: 'eder-establishment-ltd',
    sourceKey: 'kampalabiz-space',
    externalRef: 'https://eder-est.com/',
    evidence:
      `kampalabiz.space/eder-est.com/contacts.html and index.html: "+256 774 130 730" ` +
      `in the contact block and a tel: link. Read ${READ_ON}.`,
    notes: SHARED_LINE_NOTE,
    contacts: [{ kind: 'phone', value: '+256 774 130 730' }],
  },
  {
    slug: 'emerald-estates',
    sourceKey: 'emeraldestatesug-com',
    externalRef: 'https://emeraldestatesug.com/',
    evidence:
      'emeraldestatesug.com/contact-us.html: "+256 774 689 100" and ' +
      `"+256 752 538 615" beside the phone icons. Read ${READ_ON}.`,
    notes:
      'The site sells plots for sale rather than trading services, so whether this is ' +
      'a business at all is a review question, not an import question.',
    contacts: [{ kind: 'phone', value: '+256 752 538 615' }],
  },
  {
    slug: 'lake-victoria-view-real-estates',
    sourceKey: 'kampalabiz-space',
    externalRef: 'https://lakevictoriaview.com/',
    evidence:
      'kampalabiz.space/lakevictoriaview.com/index.html: "You can call us on ' +
      `+256 774 130 730" on the "We Are Coming Soon" page. Read ${READ_ON}.`,
    notes: SHARED_LINE_NOTE,
    contacts: [{ kind: 'phone', value: '+256 774 130 730' }],
  },
  {
    slug: 'mamas-food',
    sourceKey: 'kampalabiz-space',
    externalRef: 'https://mamasfood.biz/',
    evidence:
      'kampalabiz.space/mamasfood.biz/contact.html: unmodified commercial template, ' +
      `phone placeholder "+00" and demo@example.com. Read ${READ_ON}.`,
    notes:
      'No contact point was added: the page publishes template placeholders, not a ' +
      'number anybody can ring. A reviewer should expect this listing to be ' +
      'unpublishable as it stands.',
    contacts: [],
  },
  {
    slug: 'nzuri-mg-tech',
    sourceKey: 'kampalabiz-space',
    externalRef: 'https://nzuri-mgtech.com/',
    evidence:
      `kampalabiz.space/nzuri-mgtech.com/contact-us.html: "+256 702 289 465". ` +
      `Read ${READ_ON}.`,
    contacts: [{ kind: 'phone', value: '+256 702 289 465' }],
  },
]

const config = loadConfig()
const app = openApp({ config })

try {
  for (const claim of CLAIMS) {
    const business = app.businesses.findBySlug(claim.slug)
    if (!business) {
      console.log(`skip       ${claim.slug}: no such business`)
      continue
    }

    const source = app.catalogue.findSourceByKey(claim.sourceKey)
    if (!source) {
      throw new Error(`No source registered for key "${claim.sourceKey}".`)
    }

    app.catalogue.recordProvenance(business.id, {
      sourceId: source.id,
      externalRef: claim.externalRef,
      evidence: claim.evidence,
      notes: claim.notes ?? null,
      attachToBusiness: true,
    })
    console.log(`provenance ${business.name} <- ${source.key}`)

    const existing = app.businesses.contacts(business.id)
    for (const contact of claim.contacts) {
      const wanted = canonicalContactValue(contact.kind, contact.value)
      if (existing.some((c) => canonicalContactValue(c.kind, c.value) === wanted)) {
        console.log(`  already  ${contact.kind} ${wanted}`)
        continue
      }
      try {
        // Private by default: a number collected from a harvested page is a claim
        // awaiting a reviewer's check, not something the directory publishes.
        app.businesses.addContact(business.id, { ...contact, isPublic: false })
        console.log(`  contact  ${contact.kind} ${wanted} (private)`)
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        console.log(`  already  ${contact.kind} ${wanted}`)
      }
    }
  }

  console.log('\n--- after ---')
  for (const row of app.db
    .prepare(
      `SELECT b.name, b.verification_state, b.catalogue_source_id, cs.key AS source_key,
              (SELECT count(*) FROM record_provenance p WHERE p.business_id = b.id) AS claims
         FROM business b
         LEFT JOIN catalogue_source cs ON cs.id = b.catalogue_source_id
        ORDER BY b.name`,
    )
    .all()) {
    const contacts = app.db
      .prepare(
        `SELECT kind, value, is_public FROM contact_point
          WHERE business_id = (SELECT id FROM business WHERE name = ?)`,
      )
      .all(row.name)
    const phones = contacts
      .filter((c) => c.kind === 'phone')
      .map((c) => `${c.value}${c.is_public ? ' (public)' : ' (private)'}`)
    console.log(
      ` ${row.name} | ${row.verification_state} | ${row.source_key ?? 'NO SOURCE'} | ` +
        `${row.claims} provenance row(s) | ${phones.join(', ') || 'no phone'}`,
    )
  }
} finally {
  app.close()
}
