/**
 * Approve one listing through the platform's own review state machine.
 *
 * This calls the same domain function the HTTP handler calls
 * (app.businesses.review), so the state change, the review_event audit row, the
 * timestamps and the search documents all move together exactly as they would
 * from the operator UI. The only step skipped is the HTTP session check, and
 * the actor recorded is the real admin account, not a null.
 */

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

const SLUG = process.argv[2] ?? 'skycomtec'
const REASON =
  process.argv[3] ??
  'Operator confirmed this is a real trading listing; approved for the public directory.'

const config = loadConfig()
const app = openApp({ config })

try {
  const admin = app.db
    .prepare(`SELECT id, email, role FROM app_user WHERE role = 'admin' AND status = 'active'`)
    .get()
  if (!admin) throw new Error('No active admin account to attribute the decision to.')

  const before = app.businesses.requireById(app.businesses.findBySlug(SLUG).id)
  console.log('before      :', JSON.stringify({
    name: before.name, status: before.status,
    verification_state: before.verification_state,
    approved_at: before.approved_at,
  }))

  if (before.verification_state === 'approved') {
    console.log('already approved; nothing to do.')
  } else {
    const updated = app.businesses.review(before.id, {
      action: 'approve',
      actor: { id: admin.id, role: admin.role },
      reason: REASON,
    })
    console.log('after       :', JSON.stringify({
      name: updated.name, status: updated.status,
      verification_state: updated.verification_state,
      approved_at: updated.approved_at,
    }))
  }

  console.log('\nreview trail:')
  for (const e of app.catalogue.eventsFor(before.id)) {
    console.log(`  ${e.created_at}  ${e.from_state} -> ${e.to_state}  (${e.action})`)
    console.log(`      actor ${e.actor_role ?? 'none'}  reason: ${e.reason ?? '-'}`)
  }

  console.log('\nsearch documents:')
  for (const d of app.db.prepare(
    `SELECT docid, length(content) AS bytes FROM search_document WHERE business_id = ?`,
  ).all(before.id)) {
    console.log(`  docid ${d.docid}  ${d.bytes} bytes of indexed content`)
  }
} finally {
  app.close()
}
