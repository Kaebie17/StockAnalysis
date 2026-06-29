/**
 * api/screener.js — Vercel serverless proxy for Screener.in
 *
 * PARSING STRATEGY (3 layers):
 *
 * Layer 1: Semantic label matching with aliases
 *   Each field has an ordered alias list. Match case-insensitively after
 *   stripping all punctuation, buttons, and whitespace from the label cell.
 *   First alias that matches wins. Covers sector variations and future label tweaks.
 *
 * Layer 2: Positional fallback
 *   If semantic matching yields < 3 populated fields, fall back to row position:
 *   row 0 = revenue, row 2 = operating profit, etc.
 *   Works because Screener table row order is stable even if labels change.
 *
 * Layer 3: Invariant check
 *   After parsing, verify core fields. If revenue is all-null AND netProfit is
 *   all-null → parser status = DEGRADED, logged for diagnostics.
 *   App degrades gracefully; never silently shows dashes.
 *
 * KEY INSIGHT: The "+" next to labels (Sales +, Net Profit +) is a <button>
 * child element inside the <td>, not text. We strip all child elements and
 * read only the direct text node content of the label cell.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// ─── Field alias maps ──────────────────────────────────────────────────────────
// Each field lists known label variants in priority order.
// Labels are matched after lowercasing and stripping all non-alpha chars.

const INCOME_ALIASES = {
  revenue:         ['sales', 'revenue', 'totalrevenue', 'netsales', 'incomefromoperations',
                    'netrevenue', 'grossrevenue', 'totalincome', 'premiumearned',
                    'netpremiumearned', 'interestearned', 'totalinterestearned',
                    'revenuefromoperations', 'grossearnedincome'],
  expenses:        ['expenses', 'totalexpenses', 'costofrevenue', 'totalcosts',
                    'expenditure', 'totalexpenditure', 'benefitsandexpenses'],
  operatingProfit: ['operatingprofit', 'ebit', 'operatingincome', 'profitfromoperations',
                    'operatingprofitloss', 'pbdit', 'operatingsurplus'],
  opm:             ['opm', 'operatingprofitmargin', 'operatingmargin'],
  otherIncome:     ['otherincome', 'otheroperatingincome', 'nonoperatingincome'],
  interest:        ['interest', 'interestexpense', 'financecosts', 'financecost',
                    'interestcost', 'interestpaid', 'borrowingcosts'],
  depreciation:    ['depreciation', 'depreciationandamortisation', 'depreciationamortization',
                    'da', 'depreciationamortisationandimpairment'],
  profitBeforeTax: ['profitbeforetax', 'pbt', 'earningsbeforetax', 'profitbeforeexceptionaltaxitems'],
  tax:             ['tax', 'taxpercent', 'taxrate', 'incometax'],
  netProfit:       ['netprofit', 'profitaftertax', 'pat', 'netincome', 'netearnings',
                    'profitlossaftertax', 'netprofitloss', 'surplus'],
  eps:             ['epsinrs', 'eps', 'earningspershare', 'basiceps', 'dilutedeps',
                    'basicearningspershare'],
  dividendPayout:  ['dividendpayout', 'dividend']
}

const BALANCE_ALIASES = {
  equityCapital:   ['equitycapital', 'sharecapital', 'paidupcapital', 'capitalstock'],
  reserves:        ['reserves', 'reservesandsurplus', 'retainedearnings', 'surplusreserves',
                    'policyholderfunds', 'fundforpolicyholders'],
  borrowings:      ['borrowings', 'totaldebt', 'longtermborrowing', 'debt', 'loans',
                    'totalborrowings', 'shorttermdebt', 'longtermdebt'],
  otherLiabilities:['otherliabilities', 'currentliabilities', 'othercurrentliabilities'],
  totalLiabilities:['totalliabilities', 'totalliabilitiesandequity', 'totalequityandliabilities'],
  fixedAssets:     ['fixedassets', 'netfixedassets', 'propertyplantequipment', 'ppe',
                    'tangibleassets', 'nettangibleassets'],
  cwip:            ['cwip', 'capitalworkinprogress', 'constructioninprogress'],
  investments:     ['investments', 'longtermfinancialinvestments', 'financialinvestments'],
  otherAssets:     ['otherassets', 'currentassets', 'othercurrentassets'],
  totalAssets:     ['totalassets', 'totalassetsproperties']
}

const CASHFLOW_ALIASES = {
  operatingCF:  ['cashfromoperatingactivity', 'netcashfromoperatingactivities',
                 'operatingactivities', 'cashflowfromoperations', 'netcashprovidedbyoperatingactivities',
                 'cashgeneratedfromoperations'],
  investingCF:  ['cashfrominvestingactivity', 'netcashfrominvestingactivities',
                 'investingactivities', 'cashflowfrominvesting'],
  financingCF:  ['cashfromfinancingactivity', 'netcashfromfinancingactivities',
                 'financingactivities', 'cashflowfromfinancing'],
  netCashFlow:  ['netcashflow', 'netchangeincash', 'netincreasedecreasecash'],
  freeCashFlow: ['freecashflow', 'fcf']
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, consolidated = 'true' } = req.query
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

  const suffix = consolidated === 'false' ? '' : '/consolidated'
  const url = `https://www.screener.in/company/${encodeURIComponent(ticker.toUpperCase())}${suffix}/`

  let html
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.screener.in/',
        'Cache-Control': 'no-cache'
      }
    })
    if (r.status === 404) return res.status(404).json({ error: `"${ticker}" not found on Screener.in` })
    if (!r.ok) return res.status(r.status).json({ error: `Screener returned ${r.status}` })
    html = await r.text()
  } catch (err) {
    return res.status(500).json({ error: `Network error: ${err.message}` })
  }

  const result = parseScreenerHTML(html, ticker)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
  return res.status(200).json(result)
}

// ─── HTML parser ───────────────────────────────────────────────────────────────

function parseScreenerHTML(html, ticker) {
  // ── Key stats from top summary block ────────────────────────────────────────
  // <ul class="company-ratios"> contains <li> each with <span class="name"> and
  // <span class="number"><span class="value">X</span></span>
  // We extract these as reference values (not used for calculations)
  const keyStats = extractKeyStats(html)

  // ── Company name ────────────────────────────────────────────────────────────
  const nameMatch = html.match(/<h1[^>]*>\s*([^<\n]+?)\s*<\/h1>/)
  const name = nameMatch ? nameMatch[1].trim() : ticker

  // ── Annual tables ────────────────────────────────────────────────────────────
  // Screener renders: Quarterly Results first, then Profit & Loss (annual),
  // then Balance Sheet, then Cash Flows. Each in a <section id="...">
  // We want the ANNUAL tables, not quarterly.

  const incomeTable   = parseSection(html, 'profit-loss',   INCOME_ALIASES)
  const balanceTable  = parseSection(html, 'balance-sheet', BALANCE_ALIASES)
  const cashflowTable = parseSection(html, 'cash-flow',     CASHFLOW_ALIASES)

  // ── Derive years from income table headers ───────────────────────────────────
  const years = incomeTable.headers  // e.g. ['Mar 2019', 'Mar 2020', ...]

  // ── Build history arrays ─────────────────────────────────────────────────────
  const incomeHistory = years.map((yr, i) => {
    const rev = getVal(incomeTable, 'revenue', i)
    const exp = getVal(incomeTable, 'expenses', i)
    const op  = getVal(incomeTable, 'operatingProfit', i)
    const dep = getVal(incomeTable, 'depreciation', i)
    const int = getVal(incomeTable, 'interest', i)
    const np  = getVal(incomeTable, 'netProfit', i)
    const eps = getVal(incomeTable, 'eps', i)
    const otherInc = getVal(incomeTable, 'otherIncome', i)
    const pbt = getVal(incomeTable, 'profitBeforeTax', i)

    // Derive operating profit if missing
    const opDerived = op ?? deriveIf(rev, exp, (r, e) => r - e)

    // EBITDA = Operating Profit + Depreciation
    const ebitda = deriveIf(opDerived, dep, (o, d) => o + d) ?? opDerived

    return {
      year: parseYear(yr),
      // Raw values with resolution tracking
      revenue:         tag(rev,      'source'),
      expenses:        tag(exp,      'source'),
      operatingProfit: tag(opDerived, op != null ? 'source' : 'derived', op != null ? null : 'Revenue − Expenses'),
      ebitda:          tag(ebitda,   dep != null && opDerived != null ? 'derived' : opDerived != null ? 'derived' : null,
                           dep != null ? 'Op.Profit + Depreciation' : 'Op.Profit (Depreciation unavailable)'),
      depreciation:    tag(dep,      'source'),
      interest:        tag(int,      'source'),
      otherIncome:     tag(otherInc, 'source'),
      profitBeforeTax: tag(pbt,      'source'),
      netProfit:       tag(np,       'source'),
      eps:             tag(eps,      'source'),
    }
  })

  const balanceHistory = years.map((yr, i) => {
    const eqCap  = getVal(balanceTable, 'equityCapital', i)
    const res    = getVal(balanceTable, 'reserves', i)
    const borr   = getVal(balanceTable, 'borrowings', i)
    const totAss = getVal(balanceTable, 'totalAssets', i)
    const totLia = getVal(balanceTable, 'totalLiabilities', i)
    const fixed  = getVal(balanceTable, 'fixedAssets', i)
    const invest = getVal(balanceTable, 'investments', i)

    // Total equity = Equity Capital + Reserves
    const equity = deriveIf(eqCap, res, (c, r) => c + r)

    return {
      year: parseYear(yr),
      equityCapital:   tag(eqCap,  'source'),
      reserves:        tag(res,    'source'),
      totalEquity:     tag(equity, eqCap != null && res != null ? 'derived' : null, 'Equity Capital + Reserves'),
      totalDebt:       tag(borr,   'source'),
      totalAssets:     tag(totAss, 'source'),
      totalLiabilities:tag(totLia, 'source'),
      fixedAssets:     tag(fixed,  'source'),
      investments:     tag(invest, 'source'),
    }
  })

  const cashflowHistory = years.map((yr, i) => {
    const opCF  = getVal(cashflowTable, 'operatingCF', i)
    const invCF = getVal(cashflowTable, 'investingCF', i)
    const finCF = getVal(cashflowTable, 'financingCF', i)
    const fcf   = getVal(cashflowTable, 'freeCashFlow', i)

    // FCF = Operating CF - CapEx; but Screener provides FCF directly
    // If FCF row missing, we can't derive without CapEx separately
    return {
      year: parseYear(yr),
      operatingCF:  tag(opCF,  'source'),
      investingCF:  tag(invCF, 'source'),
      financingCF:  tag(finCF, 'source'),
      freeCashFlow: tag(fcf,   'source'),
    }
  })

  // ── Invariant check ──────────────────────────────────────────────────────────
  const parserStatus = checkInvariants({ incomeHistory, balanceHistory, cashflowHistory })

  // ── Positional fallback if degraded ─────────────────────────────────────────
  if (parserStatus.degraded && incomeTable.rawRows.length > 0) {
    console.warn(`[screener] Invariant failed for ${ticker}, attempting positional fallback`)
    applyPositionalFallback(incomeHistory, balanceHistory, cashflowHistory, incomeTable, balanceTable, cashflowTable, years)
  }

  return {
    source: 'screener',
    ticker: ticker.toUpperCase(),
    name,
    currency: 'INR',
    unit: 'Crores',
    // Live stats from key stats block (reference only — not used for engine calculations)
    keyStats,
    // Time-series raw data — all in Crores
    incomeHistory:   incomeHistory.filter(r => r.year),
    balanceHistory:  balanceHistory.filter(r => r.year),
    cashflowHistory: cashflowHistory.filter(r => r.year),
    parserStatus
  }
}

// ─── Section parser ────────────────────────────────────────────────────────────

function parseSection(html, sectionId, aliasMap) {
  // Find the section. Screener uses <section id="profit-loss"> etc.
  // We look for the SECOND occurrence of the section — the first is quarterly,
  // the second is annual (Profit & Loss section appears after Quarterly Results).
  // Actually Screener uses different section IDs: #quarters for quarterly,
  // #profit-loss for annual. So we just find the section by ID.
  const re = new RegExp(
    `<section[^>]+id=["']${sectionId}["'][^>]*>([\\s\\S]*?)</section>`,
    'i'
  )
  const match = html.match(re)
  if (!match) return { headers: [], rows: {}, rawRows: [] }

  const sectionHTML = match[1]

  // ── Parse headers (year columns) ──────────────────────────────────────────
  // <thead><tr><th>...</th><th>Mar 2019</th>...</tr></thead>
  const theadMatch = sectionHTML.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
  const headers = []
  if (theadMatch) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi
    let m
    while ((m = thRe.exec(theadMatch[1])) !== null) {
      const text = stripHTML(m[1]).trim()
      if (text && text !== '') headers.push(text)
    }
    headers.shift() // remove first th (label column header, usually empty)
  }

  // ── Parse rows ────────────────────────────────────────────────────────────
  // Each <tr> in <tbody>: first <td> is the label, rest are values
  const tbodyMatch = sectionHTML.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
  const rawRows = []
  const rows = {}  // keyed by field name

  if (tbodyMatch) {
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch
    while ((trMatch = trRe.exec(tbodyMatch[1])) !== null) {
      const cells = []
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
      let tdMatch
      while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
        cells.push(tdMatch[1])
      }
      if (cells.length < 2) continue

      // Label: strip ALL child HTML elements (buttons, spans, links) — take text only
      const rawLabel = stripHTML(cells[0]).trim()
      const normalizedLabel = normalizeLabel(rawLabel)

      // Values: parse numbers, handle commas and % signs
      const values = cells.slice(1).map(c => parseScreenerNum(stripHTML(c)))

      rawRows.push({ rawLabel, normalizedLabel, values })

      // Match against alias map
      for (const [field, aliases] of Object.entries(aliasMap)) {
        for (const alias of aliases) {
          if (normalizedLabel === alias || normalizedLabel.startsWith(alias)) {
            if (!rows[field]) rows[field] = values  // first match wins
            break
          }
        }
      }
    }
  }

  return { headers, rows, rawRows }
}

// ─── Key stats extractor ───────────────────────────────────────────────────────

function extractKeyStats(html) {
  const stats = {}

  // Pattern: <li><span class="name">Label</span><span class="number"><span class="value">X</span></span></li>
  // Also handles: <li><span class="name">Label</span><span class="number">X</span></li>
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let liMatch
  while ((liMatch = liRe.exec(html)) !== null) {
    const liContent = liMatch[1]

    // Extract name
    const nameMatch = liContent.match(/<span[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    if (!nameMatch) continue
    const name = stripHTML(nameMatch[1]).trim()
    if (!name) continue

    // Extract value — try nested span.value first, then direct number span content
    const valMatch = liContent.match(/<span[^>]*class="[^"]*(?:value|number)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    if (!valMatch) continue
    const rawVal = stripHTML(valMatch[1]).trim()
    const num = parseScreenerNum(rawVal)

    const key = normalizeLabel(name)
    if (num !== null) stats[key] = { raw: rawVal, value: num }
    else if (rawVal) stats[key] = { raw: rawVal, value: null }
  }

  return stats
}

// ─── Invariant checker ────────────────────────────────────────────────────────

function checkInvariants({ incomeHistory, balanceHistory, cashflowHistory }) {
  const issues = []

  const hasRevenue    = incomeHistory.some(r => r.revenue?.value != null && r.revenue.value > 0)
  const hasNetProfit  = incomeHistory.some(r => r.netProfit?.value != null)
  const hasTotalAssets = balanceHistory.some(r => r.totalAssets?.value != null && r.totalAssets.value > 0)
  const hasCashflow   = cashflowHistory.some(r => r.operatingCF?.value != null)

  if (!hasRevenue)     issues.push('revenue')
  if (!hasNetProfit)   issues.push('netProfit')
  if (!hasTotalAssets) issues.push('totalAssets')
  if (!hasCashflow)    issues.push('operatingCF')

  return {
    degraded: issues.length >= 2,  // 2+ core fields missing = structural issue
    missingCore: issues,
    message: issues.length === 0
      ? 'ok'
      : issues.length >= 2
        ? `Parser may have failed to extract: ${issues.join(', ')}. Attempting positional fallback.`
        : `Could not extract: ${issues.join(', ')}. May not be available for this company type.`
  }
}

// ─── Positional fallback ──────────────────────────────────────────────────────
// If semantic matching failed, use row position within the table.
// Screener P&L row order is stable: 0=Revenue, 1=Expenses, 2=OpProfit, 3=OPM%,
// 4=OtherIncome, 5=Interest, 6=Depreciation, 7=PBT, 8=Tax%, 9=NetProfit, 10=EPS

function applyPositionalFallback(incomeHistory, balanceHistory, cashflowHistory,
  incomeTable, balanceTable, cashflowTable, years) {

  const INCOME_POSITIONS = {
    revenue: 0, expenses: 1, operatingProfit: 2,
    otherIncome: 4, interest: 5, depreciation: 6,
    profitBeforeTax: 7, netProfit: 9, eps: 10
  }

  years.forEach((yr, i) => {
    const row = incomeHistory[i]
    if (row.revenue?.value != null) return  // semantic worked, skip

    for (const [field, pos] of Object.entries(INCOME_POSITIONS)) {
      if (incomeTable.rawRows[pos]) {
        const val = incomeTable.rawRows[pos].values[i]
        if (val != null && row[field]?.value == null) {
          row[field] = tag(val, 'positional', `Row ${pos + 1} of P&L table`)
        }
      }
    }

    // Re-derive EBITDA after positional fill
    const op  = row.operatingProfit?.value
    const dep = row.depreciation?.value
    if (op != null && row.ebitda?.value == null) {
      row.ebitda = tag(
        dep != null ? op + dep : op,
        'derived',
        dep != null ? 'Op.Profit + Depreciation (positional)' : 'Op.Profit (positional)'
      )
    }
  })

  // Balance positional: 0=EquityCap, 1=Reserves, 2=Borrowings, 4=TotalLiabilities,
  // 5=FixedAssets, 7=Investments, 9=TotalAssets
  const BAL_POSITIONS = { equityCapital: 0, reserves: 1, borrowings: 2, totalLiabilities: 4, fixedAssets: 5, investments: 7, totalAssets: 9 }
  years.forEach((yr, i) => {
    const row = balanceHistory[i]
    if (row.totalAssets?.value != null) return
    for (const [field, pos] of Object.entries(BAL_POSITIONS)) {
      if (balanceTable.rawRows[pos] && row[field]?.value == null) {
        const val = balanceTable.rawRows[pos].values[i]
        if (val != null) row[field] = tag(val, 'positional', `Row ${pos + 1} of Balance Sheet`)
      }
    }
    const eqCap = row.equityCapital?.value
    const res   = row.reserves?.value
    if (eqCap != null && res != null && row.totalEquity?.value == null) {
      row.totalEquity = tag(eqCap + res, 'derived', 'Equity Capital + Reserves (positional)')
    }
  })

  // Cashflow positional: 0=OperatingCF, 1=InvestingCF, 2=FinancingCF, 4=FCF
  const CF_POSITIONS = { operatingCF: 0, investingCF: 1, financingCF: 2, freeCashFlow: 4 }
  years.forEach((yr, i) => {
    const row = cashflowHistory[i]
    if (row.operatingCF?.value != null) return
    for (const [field, pos] of Object.entries(CF_POSITIONS)) {
      if (cashflowTable.rawRows[pos] && row[field]?.value == null) {
        const val = cashflowTable.rawRows[pos].values[i]
        if (val != null) row[field] = tag(val, 'positional', `Row ${pos + 1} of Cash Flow`)
      }
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip all HTML tags and decode basic entities */
function stripHTML(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize a label to lowercase letters and digits only, for alias matching */
function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Parse a Screener number string: "1,23,456" → 123456, "18%" → 18 */
function parseScreenerNum(str) {
  if (!str || str === '' || str === '-') return null
  const cleaned = String(str).replace(/,/g, '').replace(/%$/, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

/** Extract year from Screener header like "Mar 2024" → "2024" */
function parseYear(header) {
  const m = header.match(/\d{4}/)
  return m ? m[0] : header
}

/** Get a field value for a column index */
function getVal(table, field, colIndex) {
  const row = table.rows[field]
  if (!row) return null
  const v = row[colIndex]
  return v != null && !isNaN(v) ? v : null
}

/** Tag a value with its resolution status */
function tag(value, status, formula = null) {
  if (value == null || status == null) return { value: null, status: 'unavailable', formula: null }
  return { value, status, formula }
}

/** Derive a value from two inputs if both are non-null */
function deriveIf(a, b, fn) {
  if (a == null || b == null) return null
  try { const r = fn(a, b); return isFinite(r) ? r : null } catch { return null }
}
