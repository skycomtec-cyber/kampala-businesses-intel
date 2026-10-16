import fs from 'node:fs'
import { createHash } from 'node:crypto'

import { ValidationError, HarvestError } from '../core/errors.js'
import { definePlan } from './plan.js'
import { localDirTransport, httpTransport } from './transport.js'
import { extractRecord } from './extract.js'
import { writeBatch } from './batch.js'
import { importBusinessesFromCsv } from '../import/index.js'

/**
 * Main harvest entry. Reads pages via the transport, extracts records, writes a
 * batch (CSV + manifest), and feeds the batch into the accountable importer.
 */
export async function harvest(app, planOrRaw, options = {}) {
  return harvestWith(app, planOrRaw, options)
}

async function harvestWith(app, planOrRaw, options = {}) {
  const {
    transport = httpTransport({ delayMs: 500, retries: 1 }),
    outputDir = './harvest-batches',
    dryRun = false,
    fromDir = null,
    batchRef = null,
    actor = null,
  } = options

  // Use a local transport when asked to read from a saved mirror tree, so we
  // stay offline even if the plan lists live URLs.
  const t = fromDir ? localDirTransport(fromDir) : transport

  const plan = definePlan(planOrRaw)
  const effectiveBatchRef = batchRef ?? plan.batchRef ?? new Date().toISOString().slice(0, 7) // YYYY-MM

  const rows = []
  const pages = []

  // Required columns for a usable record
  const required = ['name', 'category', 'location']

  for (const page of plan.pages) {
    let pageRead
    try {
      pageRead = await t.read(page)
    } catch (error) {
      throw new HarvestError(error.message, { cause: error })
    }
    if (pageRead.status !== 200) {
      throw new HarvestError(
        `Page ${page.url} returned ${pageRead.status}; harvest refused to emit an incomplete batch.`,
        { url: page.url, status: pageRead.status },
      )
    }

    const extracted = extractRecord(pageRead.body, plan.fields, { page: pageRead, plan })
    const missing = required.filter((c) => !extracted[c] || String(extracted[c]).trim() === '')
    if (missing.length > 0) {
      throw new HarvestError(
        `Page ${page.url} yielded a record missing ${missing.join(', ')}; harvest refused to emit an incomplete batch.`,
        { url: page.url, missing },
      )
    }

    const evidence = extracted.evidence ?? pageRead.finalUrl ?? page.url
    const externalRef = extracted.external_ref ?? page.url
    rows.push({ ...extracted, evidence, external_ref: externalRef })

    // What we actually read, byte for byte, so the manifest can prove exactly
    // which page produced which record.
    const bytes = Buffer.from(pageRead.body, 'utf8')
    pages.push({
      url: pageRead.finalUrl ?? page.url,
      mirror: page.mirror ?? null,
      ref: page.ref ?? null,
      fetchedAt: pageRead.fetchedAt ?? null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: pageRead.headers?.['content-type'] ?? 'text/html',
      records: [externalRef],
    })
  }

  if (rows.length === 0) {
    throw new HarvestError('Harvest produced no records.', { sourceKey: plan.sourceKey })
  }

  if (dryRun) {
    return {
      plan,
      rows,
      manifest: null,
      import: null,
      files: null,
      dryRun: true,
    }
  }

  if (!app) {
    throw new ValidationError('The harvest engine needs a database handle. Pass `app` or run via the CLI.')
  }

  const baseName = `${plan.sourceKey}-${effectiveBatchRef.replace(/[^a-z0-9_-]+/gi, '-')}`
  const batch = writeBatch({ plan, rows, pages, outDir: outputDir, baseName, batchRef: effectiveBatchRef })

  const csvText = fs.readFileSync(batch.csvPath, 'utf8')
  const result = importBusinessesFromCsv(app, csvText, {
    sourceKey: plan.sourceKey,
    batchRef: effectiveBatchRef,
    filename: batch.csvPath,
    evidence: plan.baseUrl ?? null,
    actor,
  })

  return {
    plan,
    rows,
    manifest: batch.manifest,
    import: result,
    files: { csv: batch.csvPath, manifest: batch.manifestPath },
    dryRun: false,
  }
}
