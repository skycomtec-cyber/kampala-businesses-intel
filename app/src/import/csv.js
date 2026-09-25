/**
 * Reading CSV, the shape an operator's spreadsheet arrives in.
 *
 * Written rather than taken from a dependency because the only hard part is
 * RFC 4180 quoting, and a directory importer that mis-parses a quoted comma in
 * a business name is worse than no importer: it writes a corrupted listing that
 * looks successful. Every parse result carries the source line it came from, so
 * a rejected row can be pointed at in the operator's spreadsheet rather than
 * described vaguely.
 */

/**
 * Parses CSV text into rows of cells.
 *
 * Handles the cases that actually occur in hand-collected spreadsheets: quoted
 * fields containing commas, newlines and doubled quotes; CRLF line endings; a
 * UTF-8 byte order mark written by Excel; and a trailing newline. It does not
 * attempt to be lenient about anything else, because silently accepting a
 * malformed file would move the error from a clear message to a mystery.
 *
 * @param {string} text
 * @returns {{ cells: string[][], lineOf: number[] }} `lineOf[i]` is the 1-based
 *   source line of row `i`, so a row index maps back to a spreadsheet row.
 * @throws {Error} on an unterminated quoted field or a quote in the middle of
 *   an unquoted field.
 */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('parseCsv expects a string')

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  const lineOf = []
  let row = []
  let field = ''
  let line = 1
  let rowStartLine = 1
  let inQuotes = false
  let quotedField = false

  const endField = () => {
    row.push(field)
    field = ''
    quotedField = false
  }
  const endRow = () => {
    endField()
    // A blank line in a spreadsheet is not a record, and treating it as one
    // would produce a row that fails validation and alarms the operator.
    if (row.length > 1 || row[0] !== '') {
      rows.push(row)
      lineOf.push(rowStartLine)
    }
    row = []
    rowStartLine = line
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        if (char === '\n') line += 1
        field += char
      }
      continue
    }

    if (char === '"') {
      if (field !== '' && !quotedField) {
        throw new Error(
          `Line ${line}: a quote may only open a field at its start, not in the middle of one.`,
        )
      }
      inQuotes = true
      quotedField = true
      continue
    }
    if (char === ',') {
      endField()
      continue
    }
    if (char === '\r') continue
    if (char === '\n') {
      line += 1
      endRow()
      continue
    }
    field += char
  }

  if (inQuotes) {
    throw new Error(
      `Line ${rowStartLine}: a quoted field is never closed. This usually means a quote inside a field was not doubled.`,
    )
  }
  if (field !== '' || row.length > 0) {
    rowStartLine = line
    endRow()
  }

  return { cells: rows, lineOf }
}

/**
 * Turns parsed rows into records keyed by header name.
 *
 * The header is matched case- and separator-insensitively, because the same
 * person who writes "Phone Number" in one spreadsheet and "phone_number" in the
 * next should not have to remember which. A required column that is absent is an
 * error naming the column and listing the ones that are present, since that is
 * the only thing an operator can act on.
 *
 * @param {{ cells: string[][], lineOf: number[] }} parsed
 * @param {{ required?: string[] }} [options]
 * @returns {{ records: object[], lineOf: number[] }}
 */
export function toRecords(parsed, { required = [] } = {}) {
  const { cells, lineOf } = parsed
  if (cells.length === 0) return { records: [], lineOf: [] }

  const header = cells[0].map(normaliseHeader)
  const present = new Set(header)

  const missing = required.filter((column) => !present.has(normaliseHeader(column)))
  if (missing.length > 0) {
    throw new Error(
      `The file is missing the required column(s): ${missing.join(', ')}. ` +
        `It has: ${header.filter(Boolean).join(', ')}.`,
    )
  }

  const records = []
  const recordLineOf = []
  for (let index = 1; index < cells.length; index += 1) {
    const values = cells[index]
    const record = {}
    for (let column = 0; column < header.length; column += 1) {
      if (!header[column]) continue
      record[header[column]] = (values[column] ?? '').trim()
    }
    records.push(record)
    recordLineOf.push(lineOf[index])
  }
  return { records, lineOf: recordLineOf }
}

/** "Phone Number", "phone_number" and "phoneNumber" all become one key. */
export function normaliseHeader(value) {
  return String(value ?? '')
    .trim()
    // The camelCase split has to happen before the lowercasing, or there is no
    // capital left to split on.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/**
 * Splits a multi-value cell.
 *
 * Businesses advertise several things on one line, and an operator writes them
 * as "salon, barbering, braiding" or sometimes with semicolons. Both are
 * accepted because both are what people type, and a cell that splits into one
 * item either way is unaffected.
 */
export function splitList(value, { separators = [',', ';', '|'] } = {}) {
  if (typeof value !== 'string') return []
  const pattern = new RegExp(`[${separators.map(escapeForCharClass).join('')}]`)
  return value
    .split(pattern)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function escapeForCharClass(char) {
  return char.replace(/[\]\\^-]/, '\\$&')
}
