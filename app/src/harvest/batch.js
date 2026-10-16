import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Write a CSV batch and a manifest that both describe the same harvested
 * records. The CSV is written in the importer's column contract; the manifest
 * records each page's provenance (SHA-256, bytes, URL, when it was fetched) and
 * which records it produced, so an operator can reproduce an accountable run.
 */

export function writeBatch({ plan, rows, pages = [], outDir, baseName, batchRef = null }) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const csvPath = path.join(outDir, `${baseName}.csv`)
  const manifestPath = path.join(outDir, `${baseName}.manifest.json`)

  const csvText = toCsv(rows)
  fs.writeFileSync(csvPath, csvText, 'utf8')

  const now = new Date().toISOString()
  const csvBytes = Buffer.from(csvText, 'utf8')
  const manifest = {
    source: { key: plan.sourceKey },
    planFile: plan.filename ?? null,
    baseUrl: plan.baseUrl ?? null,
    batchRef: batchRef ?? plan.batchRef ?? null,
    generatedAt: now,
    csvPath,
    csvSha256: sha256(csvBytes),
    csvBytes: csvBytes.length,
    pages,
    totals: {
      records: rows.length,
      pages: pages.length,
    },
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  return { csvPath, manifestPath, manifest }
}

export function toCsv(rows) {
  const header = Array.from(
    new Set([
      'name',
      'category',
      'location',
      'description',
      'address',
      'latitude',
      'longitude',
      'phone',
      'whatsapp',
      'email',
      'website',
      'facebook',
      'services',
      'skills',
      'founded_year',
      'status',
      'verification_state',
      'capability_level',
      'source',
      'external_ref',
      'evidence',
    ]),
  )
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      header
        .map((column) => quote(cellValue(row[column])))
        .join(','),
    )
  }
  return lines.join('\n') + '\n'
}

function cellValue(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function quote(cell) {
  if (/[",\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`
  return cell
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
