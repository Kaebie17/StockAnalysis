/**
 * src/utils/pasteParser.js
 *
 * Parses a copy-pasted financial table (from Screener, a company's IR
 * page, or anywhere else) into the same tagged data shape the rest of
 * the app already understands.
 *
 * Browsers serialize a copied HTML <table> as tab-separated cells with
 * newline-separated rows — this is consistent across Chrome/Safari/
 * Firefox. We also handle space-separated as a fallback for cases
 * where tab-separation didn't survive (some mobile copy paths).
 *
 * Reuses the exact same alias maps and number-parsing logic already
 * proven in api/screener.js, just applied to plain text instead of HTML.
 */

const ALIASES = {
  income: {
    revenue:         ['sales', 'revenue', 'totalrevenue', 'netsales', 'incomefromoperations',
                       'revenuefromoperations', 'premiumearned', 'interestearned', 'totalinterestearned'],
    operatingProfit: ['operatingprofit', 'ebit', 'operatingincome', 'profitfromoperations', 'pbdit'],
    depreciation:    ['depreciation', 'depreciationandamortisation', 'da'],
    interest:        ['interest', 'interestexpense', 'financecosts', 'financecost'],
    netProfit:       ['netprofit', 'profitaftertax', 'pat', 'netincome', 'netearnings'],
    eps:             ['epsinrs', 'eps', 'earningspershare', 'basiceps', 'dilutedeps'],
  },
  balance: {
    equityCapital: ['equitycapital', 'sharecapital', 'paidupcapital'],
    reserves:      ['reserves', 'reservesandsurplus', 'retainedearnings'],
    totalDebt:     ['borrowings', 'totaldebt', 'longtermborrowing', 'debt', 'loans'],
    totalAssets:   ['totalassets'],
  },
  cashflow: {
    operatingCF:  ['cashfromoperatingactivity', 'netcashfromoperatingactivities', 'operatingactivities'],
    freeCashFlow: ['freecashflow', 'fcf'],
  },
}

function normalizeLabel(l) {
  return l.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function parseNum(s) {
  if (s == null) return null
  const str = String(s).trim()
  if (!str || str === '-' || str === '--') return null
  const clean = str.replace(/,/g, '').replace(/%$/, '').replace(/^\((.*)\)$/, '-$1').trim()
  const n = parseFloat(clean)
  return isNaN(n) ? null : n
}

/** Detect if a row looks like year headers (e.g. "Mar 2021", "2021", "FY21") */
function looksLikeYearHeader(cells) {
  const yearish = cells.filter(c => /\b(19|20)\d{2}\b|FY\d{2}/.test(c))
  return yearish.length >= Math.max(1, cells.length - 1)
}

function extractYear(cell) {
  const m = cell.match(/\b(19|20)\d{2}\b/)
  return m ? m[0] : cell.trim()
}

function splitRow(line) {
  // Try tab-separated first (standard browser table-copy behavior)
  let cells = line.split('\t')
  if (cells.length > 1) return cells.map(c => c.trim())
  // Fallback: 2+ consecutive spaces as a separator
  cells = line.split(/\s{2,}/)
  return cells.map(c => c.trim())
}

/**
 * Parse pasted text for a specific table type ('income' | 'balance' | 'cashflow').
 * Returns { years: string[], rows: [{year, ...taggedFields}], warnings: string[] }
 */
export function parsePastedTable(text, tableType) {
  // IMPORTANT: don't .trim() each line — that strips a leading tab
  // (the empty first header cell above the label column), which
  // shifts every year by one column. Only strip trailing \r and
  // filter on whether the line has any real content.
  const lines = text.split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim().length > 0)
  if (lines.length < 2) {
    return { years: [], rows: [], warnings: ['Pasted content has too few rows. Make sure you copied the full table including headers.'] }
  }

  const aliasMap = ALIASES[tableType]
  const warnings = []

  // Find header row (years) — usually first row, but scan first 2 in case of stray text
  let headerIdx = 0
  let years = []
  for (let i = 0; i < Math.min(2, lines.length); i++) {
    const cells = splitRow(lines[i])
    if (looksLikeYearHeader(cells.slice(1))) {
      headerIdx = i
      years = cells.slice(1).map(extractYear)
      break
    }
  }

  if (years.length === 0) {
    warnings.push('Could not detect year headers in the pasted text. Years may be misaligned — please verify in the preview below.')
    // Fallback: assume first row IS data, generate placeholder years
    const firstRowCells = splitRow(lines[0])
    years = firstRowCells.slice(1).map((_, i) => `Year ${i + 1}`)
    headerIdx = -1 // no header row to skip
  }

  // Parse data rows
  const fieldsByYear = years.map(() => ({}))
  let matchedCount = 0

  for (let i = 0; i < lines.length; i++) {
    if (i === headerIdx) continue
    const cells = splitRow(lines[i])
    if (cells.length < 2) continue

    const rawLabel = cells[0]
    const norm = normalizeLabel(rawLabel)
    const values = cells.slice(1, years.length + 1).map(parseNum)

    let matchedField = null
    for (const [field, aliases] of Object.entries(aliasMap)) {
      if (aliases.some(a => norm === a || norm.startsWith(a))) {
        matchedField = field
        break
      }
    }

    if (matchedField) {
      matchedCount++
      values.forEach((v, yi) => {
        if (yi < fieldsByYear.length) fieldsByYear[yi][matchedField] = v
      })
    }
  }

  if (matchedCount === 0) {
    warnings.push(`No recognizable ${tableType === 'income' ? 'Profit & Loss' : tableType === 'balance' ? 'Balance Sheet' : 'Cash Flow'} line items found. Make sure you copied the right table.`)
  }

  const rows = years.map((year, i) => ({ year, ...fieldsByYear[i] }))

  return { years, rows, warnings, matchedCount }
}

/**
 * Convert parsed rows into the tagged shape used elsewhere (status: 'pasted').
 *
 * opts.scale multiplies every monetary field (Screener reports in ₹ Crore, but
 * the rest of the app stores absolute currency, so callers pass scale=1e7 for
 * .NS/.BO tickers). Per-share fields in SKIP_SCALE are never scaled.
 */
const SKIP_SCALE = new Set(['eps'])

export function tagPastedRows(rows, tableType, opts = {}) {
  const scale = opts.scale ?? 1
  return rows.map(row => {
    const tagged = { year: row.year }
    for (const [key, value] of Object.entries(row)) {
      if (key === 'year') continue
      const scaled = value != null && !SKIP_SCALE.has(key) ? value * scale : value
      tagged[key] = scaled != null
        ? { value: scaled, status: 'pasted', formula: null }
        : { value: null, status: 'unavailable', formula: null }
    }
    return tagged
  })
}
