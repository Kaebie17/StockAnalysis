
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

import { screenerAliases, METRICS, TABLE_SHAPE } from '../engine/metrics.js'

// Row labels come from the ONE dictionary (src/engine/metrics.js), not a private
// copy. api/screener.js had its own duplicate of this list; normalize.js had
// Yahoo's names inline; sec.js had the tags; arExtract had the AR phrasings. None
// could see each other, so nothing could answer "cash is missing — what does each
// source call it?". Now they all read the same entries.
const ALIASES = {
  income:   screenerAliases('income'),
  balance:  screenerAliases('balance'),
  cashflow: screenerAliases('cashflow'),
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
  let shape = { ok: true }

  // Classify each header column (after the label cell) as a real year, YTD,
  // TTM, or a stray column. A 4-digit year is taken even if a mark is glued to
  // it ("Mar 2015", "2015*", "FY2015"). Keepers = real years + YTD (current
  // FY-to-date, a genuine latest period). Dropped = TTM (a trailing-12-month
  // window that overlaps the last FY) and any stray/blank column, wherever it
  // sits. Stray columns never carry real data, so row values (numbers only,
  // below) skip them automatically.
  let headerIdx = -1
  let colKinds = []   // per cell: '2015'… | 'TTM' | null
  let colMonths = []  // month of each real year column, for the annual check
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const cells = splitRow(lines[i])
    // Classify EVERY cell (do not assume a leading empty "corner" cell). An empty
    // corner, a title, or a row-label header all classify as null and drop out,
    // so a real first year (e.g. "Mar 2015") is never sliced off by mistake.
    colMonths = []
    const cand = cells.map(c => {
      // Match a 4-digit year even when letters or a symbol are glued to it
      // ("FY2026", "2026+", "Mar 2024*"), but not when it's part of a longer
      // number ("20250"). Non-digit neighbours are fine; digit neighbours aren't.
      const m = c.match(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/)
      if (m) {
        // Remember the month too. Annual Screener columns all share one month
        // ("Mar 2023, Mar 2024"); a quarterly table walks Mar/Jun/Sep/Dec. That
        // difference is the only reliable way to tell the two tables apart.
        const mon = c.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)
        colMonths.push(mon ? mon[1].toLowerCase() : null)
        return m[1]
      }
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

  // GATE — before a single number is read. A wrong table or a quarterly table is
  // a mistake to correct, not data to salvage: parsing it would only produce a
  // plausible-looking wrong answer. This is the ONLY check on a paste now. The
  // old one compared every value against Yahoo, which made the weaker source the
  // judge of the stronger one, and failed on Yahoo's own holes.
  if (headerIdx !== -1) {
    shape = checkShape(tableType, years, colMonths, lines.slice(headerIdx + 1))
    if (!shape.ok) {
      return { years: [], rows: [], warnings: shape.warnings, matchedCount: 0, shape, rejected: true }
    }
  }

  // Parse data rows
  const fieldsByYear = years.map(() => ({}))
  const pctLabels = new Set()   // fields whose Screener label carried a '%'
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
      // The RAW label is the only place the percent lives — normalizeLabel strips
      // the '%' away, so "Material Cost %" and "Material Cost" look identical
      // after it. Capture it here, before that happens.
      if (/%/.test(rawLabel)) pctLabels.add(matchedField)
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

  // PERCENT vs ABSOLUTE, decided by the LABEL.
  //
  // Screener prints some rows as a percent of something ("Material Cost %",
  // "OPM %", "Tax %") and others as absolute crore. Both are possible for the
  // same metric. The label is the only reliable signal: guessing from magnitude
  // ("under 100 must be a percent") reads Rs45cr of material cost on Rs1000cr of
  // revenue as 45% -> Rs450cr. Silently, and ten times wrong.
  //
  // Converting % -> absolute is unit handling, which IS the source's job. Working
  // out gross profit from it is not — that lives in ratios.js, once, for every
  // source. It used to live here AND in api/sec.js.
  for (const [key, m] of Object.entries(METRICS)) {
    if (!m.pctOf) continue
    for (let i = 0; i < fieldsByYear.length; i++) {
      const f = fieldsByYear[i]
      if (f[key] == null || !pctLabels.has(key)) continue     // absolute — leave it
      const base = f[m.pctOf]
      f[key] = base != null ? base * (f[key] / 100) : null
    }
  }
  // 0% material cost = a services company with no materials. Null, not a claim
  // of a 100% gross margin.
  for (const f of fieldsByYear) {
    if (f.cogs != null && f.cogs <= 0) f.cogs = null
  }

  const rows = years.map((year, i) => ({ year, ...fieldsByYear[i] }))
  return { years, rows, warnings, matchedCount, shape }
}

/**
 * The whole check, now. Two questions, asked BEFORE anything is parsed:
 *
 *   1. Is this the table you think it is? (right rows in the right box)
 *   2. Is it annual, not quarterly? (shareholding exempt — it IS quarterly)
 *
 * That's it. The old check compared every pasted number against Yahoo at 3
 * significant figures and threw out the entire paste on one mismatch — which
 * made Yahoo, the weaker source, the judge of Screener, the stronger one. It also
 * failed on Yahoo's own holes and on our own parser misses, neither of which is
 * anything to do with the paste.
 *
 * Arithmetic self-checks (Sales − Expenses = Operating Profit, etc.) were
 * considered and dropped: Screener rounds to crore, so they'd need a tolerance
 * band, and arguing about the band is what made the old check bad.
 *
 * Nothing numeric is gated any more, because nothing needs to be: an unread row
 * is now a reported gap, not an invented number.
 */
export function checkShape(tableType, years, colMonths, bodyLines) {
  const warnings = []
  const spec = TABLE_SHAPE[tableType]
  if (!spec) return { ok: true, quarterly: false, wrongTable: false, warnings }

  // 1. RIGHT TABLE — score the pasted row LABELS against every statement, not
  // just the box they landed in. Scoring only the target can tell you "these
  // aren't P&L rows"; scoring all of them can tell you "that's the balance sheet,
  // put it in the other box" — which is the message worth showing.
  const labels = bodyLines.map(l => normalizeLabel(splitRow(l)[0] || ''))
  const scoreOf = (t) => {
    const aliases = screenerAliases(t)
    let n = 0
    for (const key of (TABLE_SHAPE[t]?.signature || [])) {
      const alts = aliases[key] || []
      if (labels.some(lab => lab && alts.some(a => lab === a || lab.startsWith(a)))) n++
    }
    return n
  }

  const mine = scoreOf(tableType)
  let best = tableType, bestScore = mine
  for (const t of Object.keys(TABLE_SHAPE)) {
    const sc = scoreOf(t)
    if (sc > bestScore) { best = t; bestScore = sc }
  }

  const wrongTable = best !== tableType && bestScore >= 2
  if (wrongTable) {
    warnings.push(`This looks like the ${TABLE_SHAPE[best].label} table, not ${spec.label}. Paste it into the ${TABLE_SHAPE[best].label} box instead.`)
  } else if (mine === 0) {
    warnings.push(`No ${spec.label} rows recognised. Check you copied the table including its row labels.`)
  }

  // 2. ANNUAL, NOT QUARTERLY — a quarterly table repeats a year across columns
  // (Mar 2024, Jun 2024, Sep 2024, Dec 2024) and walks the month. Annual does
  // neither. Shareholding is quarterly by nature and skips this.
  let quarterly = false
  if (spec.annual) {
    const dupYear = new Set(years).size < years.length
    const varies  = new Set(colMonths.filter(Boolean)).size > 1
    quarterly = dupYear || varies
    if (quarterly) {
      warnings.push('This looks like the quarterly table. Switch Screener to the annual view and copy that instead.')
    }
  }

  return { ok: !wrongTable && !quarterly && mine > 0, quarterly, wrongTable, matched: mine, looksLike: best, warnings }
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