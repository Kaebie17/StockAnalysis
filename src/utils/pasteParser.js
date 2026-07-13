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
    materialCostPct: ['materialcost'],
  },
  balance: {
    equityCapital: ['equitycapital', 'sharecapital', 'paidupcapital'],
    reserves:      ['reserves', 'reservesandsurplus', 'retainedearnings'],
    totalEquity:   ['totalequity', 'networth', 'shareholdersfunds', 'shareholdersfund', 'totalshareholdersfunds'],
    totalDebt:     ['borrowings', 'totaldebt', 'longtermborrowing', 'debt', 'loans'],
    // Screener labels the balance-sheet total simply "Total" (it appears twice —
    // once for liabilities+equity, once for assets — and both equal total assets
    // because the sheet balances). Match it so a Screener BS paste populates it.
    totalAssets:   ['totalassets', 'total', 'totalequityandliabilities', 'totalliabilities', 'totalliabilitiesandequity'],
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

  // Classify each header column (after the label cell) as a real year, YTD,
  // TTM, or a stray column. A 4-digit year is taken even if a mark is glued to
  // it ("Mar 2015", "2015*", "FY2015"). Keepers = real years + YTD (current
  // FY-to-date, a genuine latest period). Dropped = TTM (a trailing-12-month
  // window that overlaps the last FY) and any stray/blank column, wherever it
  // sits. Stray columns never carry real data, so row values (numbers only,
  // below) skip them automatically.
  let headerIdx = -1
  let colKinds = []   // per cell: '2015'… | 'TTM' | null
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const cells = splitRow(lines[i])
    // Classify EVERY cell (do not assume a leading empty "corner" cell). An empty
    // corner, a title, or a row-label header all classify as null and drop out,
    // so a real first year (e.g. "Mar 2015") is never sliced off by mistake.
    const cand = cells.map(c => {
      // Match a 4-digit year even when letters or a symbol are glued to it
      // ("FY2026", "2026+", "Mar 2024*"), but not when it's part of a longer
      // number ("20250"). Non-digit neighbours are fine; digit neighbours aren't.
      const m = c.match(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/)
      if (m) return m[1]
      // TTM and YTD are both partial/overlapping periods — drop for now.
      if (/\bttm\b/i.test(c)) return 'TTM'
      if (/\bytd\b/i.test(c)) return 'TTM'
      return null
    })
    const keepers = cand.filter(k => k && k !== 'TTM')   // real years
    if (keepers.length >= 2) {                            // a real year header row
      headerIdx = i
      colKinds = cand
      break
    }
  }

  let years
  if (headerIdx === -1) {
    warnings.push('Could not detect year headers in the pasted text. Years may be misaligned — please verify in the preview below.')
    const firstRowCells = splitRow(lines[0])
    colKinds = firstRowCells.map((_, i) => `Year ${i + 1}`)
    years = colKinds.slice()
  } else {
    years = colKinds.filter(k => k && k !== 'TTM')   // real years, in order
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

    // Values = the numeric cells only. Whatever follows the label — a "+" /
    // expander, an "*"/footnote, an arrow, a "Note" tag, a blank — is non-numeric
    // and simply isn't picked up, so alignment doesn't depend on how many marker
    // cells a row has. (An inline mark stuck to a number like "10,572*" still
    // parses to the number.)
    const numeric = cells.map(parseNum).filter(v => v != null)

    // Drop trailing non-kept columns (TTM / stray) from the right edge; YTD is a
    // keeper so it stops this. Then right-align so the most recent period is last.
    let trailingExtra = 0
    for (let k = colKinds.length - 1; k >= 0 && (!colKinds[k] || colKinds[k] === 'TTM'); k--) trailingExtra++
    const usable  = trailingExtra > 0 ? numeric.slice(0, Math.max(0, numeric.length - trailingExtra)) : numeric
    const aligned = usable.slice(Math.max(0, usable.length - years.length))
    const padded  = Array(Math.max(0, years.length - aligned.length)).fill(null).concat(aligned)

    let matchedField = null
    for (const [field, aliases] of Object.entries(aliasMap)) {
      if (aliases.some(a => norm === a || norm.startsWith(a))) {
        matchedField = field
        break
      }
    }

    if (matchedField) {
      matchedCount++
      padded.forEach((v, yi) => {
        if (yi < fieldsByYear.length) fieldsByYear[yi][matchedField] = v
      })
    }
  }

  if (matchedCount === 0) {
    warnings.push(`No recognizable ${tableType === 'income' ? 'Profit & Loss' : tableType === 'balance' ? 'Balance Sheet' : 'Cash Flow'} line items found. Make sure you copied the right table.`)
  }

  // Screener's balance sheet has no "Total Equity" row — it splits it into
  // "Equity Capital" + "Reserves". Derive it so equity-based metrics (ROE, D/E,
  // ROA context) and the gap alert resolve after a balance-sheet import.
  if (tableType === 'balance') {
    for (const f of fieldsByYear) {
      if (f.totalEquity == null && f.equityCapital != null && f.reserves != null) {
        f.totalEquity = f.equityCapital + f.reserves
      }
    }
  }

  // Screener's expense breakup gives Material Cost % (of sales). Recover the
  // otherwise-missing gross profit = revenue × (1 − materialCost%/100) so gross
  // margin flows through the normal ratios / Block-5 paths. Material-only =
  // standard gross-margin convention; 0% (services co) → left null.
  if (tableType === 'income') {
    for (const f of fieldsByYear) {
      if (f.grossProfit == null && f.revenue != null && f.materialCostPct != null && f.materialCostPct > 0) {
        f.grossProfit = f.revenue * (1 - f.materialCostPct / 100)
      }
      delete f.materialCostPct
    }
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
