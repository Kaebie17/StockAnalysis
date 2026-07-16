
/**
 * api/sec.js — SEC EDGAR (XBRL companyfacts) financial history for US tickers.
 *
 * Fills the same slot Screener fills for Indian tickers: deep annual financial
 * history. Yahoo still supplies price / market cap / priceHistory / meta.
 *
 * Why a server proxy:
 *   • SEC requires a User-Agent identifying the caller (browser can't set it)
 *   • avoids CORS
 *   • keeps the ticker→CIK map cached warm across invocations
 *
 * Rate limit: SEC allows 10 req/sec per IP. One analyse = ~1-2 requests, so this
 * is a non-issue; we still cache the CIK map to keep it minimal.
 *
 * Returns Screener-SHAPED data on purpose, so the existing merge path consumes it
 * with no engine changes:
 *   { incomeHistory:[{year,...}], balanceHistory:[...], cashflowHistory:[...] }
 */

const UA = process.env.SEC_USER_AGENT || 'StockAnalyzr (contact: set SEC_USER_AGENT env var)'
const MAX_YEARS = 12   // valuation caps growth windows at ~10y; 12 covers it with margin

// ── XBRL concept mapping ─────────────────────────────────────────────────────
// The us-gaap taxonomy IS standardised, but several valid tags exist per concept
// and the taxonomy evolved (e.g. ASC 606 changed revenue tagging in 2018), so a
// long history legitimately spans multiple tags. Hence an ordered fallback chain
// per field: first tag that yields data for a year wins. Extend a chain when a
// filer (bank/REIT/insurer) comes back null — that's a one-line addition.
const CONCEPTS = {
  income: {
    revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax',
              'RevenueFromContractWithCustomerIncludingAssessedTax',
              'Revenues', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
    grossProfit:     ['GrossProfit'],
    operatingProfit: ['OperatingIncomeLoss'],
    netProfit:       ['NetIncomeLoss', 'ProfitLoss'],
    interest:        ['InterestExpense', 'InterestIncomeExpenseNet',
                      'InterestExpenseDebt', 'InterestExpenseNonoperating'],
    depreciation:    ['DepreciationDepletionAndAmortization',
                      'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
    eps:             ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  },
  balance: {
    totalAssets:        ['Assets'],
    totalEquity:        ['StockholdersEquity',
                         'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    cash:               ['CashAndCashEquivalentsAtCarryingValue',
                         'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    currentAssets:      ['AssetsCurrent'],
    currentLiabilities: ['LiabilitiesCurrent'],
    longTermDebt:       ['LongTermDebtNoncurrent', 'LongTermDebt'],
    shortTermDebt:      ['LongTermDebtCurrent', 'ShortTermBorrowings',
                         'DebtCurrent', 'OtherShortTermBorrowings'],
  },
  cashflow: {
    operatingCF: ['NetCashProvidedByUsedInOperatingActivities',
                  'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    capex:       ['PaymentsToAcquirePropertyPlantAndEquipment',
                  'PaymentsToAcquireProductiveAssets'],
  },
}

// ── ticker → CIK (cached warm per lambda instance) ───────────────────────────
let cikMap = null, cikFetchedAt = 0
const CIK_TTL = 24 * 60 * 60 * 1000

async function getCik(ticker) {
  const now = Date.now()
  if (!cikMap || now - cikFetchedAt > CIK_TTL) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    })
    if (!r.ok) throw new Error(`SEC ticker map ${r.status}`)
    const raw = await r.json()
    cikMap = {}
    for (const v of Object.values(raw)) {
      if (v?.ticker) cikMap[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0')
    }
    cikFetchedAt = now
  }
  return cikMap[ticker.toUpperCase()] || null
}

/**
 * Extract an annual series for one concept chain.
 * Handles: annual (10-K/FY) filtering, restatement dedupe (latest filing wins),
 * and merging across tag regimes (a later tag fills years an earlier one lacks).
 */
// A duration fact spanning ~a year. companyfacts carries entries filed IN a 10-K
// that are tagged fp:'FY' but cover a QUARTER (e.g. the quarterly-data note). The
// old filter (fp==='FY' && form==='10-K') accepted those, so a Q4 revenue/capex/
// opCF figure could land in the annual series — and the restatement dedupe, which
// keeps the latest `filed`, could actively prefer it. Instant facts (balance
// sheet) have no `start` and are unaffected.
function isAnnual(e) {
  if (!e.start) return true                     // instant fact (balance sheet)
  const days = (new Date(e.end) - new Date(e.start)) / 86400000
  return days >= 300 && days <= 400             // 52/53-week years included
}

function seriesFor(facts, tags) {
  const byYear = {}   // year -> { val, filed }
  for (const tag of tags) {
    const units = facts?.['us-gaap']?.[tag]?.units
    if (!units) continue
    // Prefer USD; per-share concepts use USD/shares.
    const arr = units.USD || units['USD/shares'] || Object.values(units)[0]
    if (!Array.isArray(arr)) continue
    for (const e of arr) {
      // Annual figures only: FY frame from a 10-K. `fp:'FY'` + form 10-K is the
      // reliable pair; `frame` presence also marks a clean annual period.
      if (e.fp !== 'FY') continue
      if (e.form !== '10-K' && e.form !== '10-K/A') continue
      if (e.val == null || !e.end) continue
      if (!isAnnual(e)) continue
      const year = String(e.end).slice(0, 4)
      const filed = e.filed || ''
      // Restatement dedupe: keep the most recently FILED value for a year.
      // Tag order also matters — an earlier chain entry wins on ties.
      const prev = byYear[year]
      if (!prev || filed > prev.filed) byYear[year] = { val: e.val, filed }
    }
  }
  return byYear
}

function buildRows(facts, conceptGroup) {
  const fields = {}
  const years = new Set()
  for (const [field, tags] of Object.entries(conceptGroup)) {
    const s = seriesFor(facts, tags)
    fields[field] = s
    Object.keys(s).forEach(y => years.add(y))
  }
  const sorted = [...years].sort().slice(-MAX_YEARS)
  return sorted.map(year => {
    const row = { year }
    for (const [field, s] of Object.entries(fields)) {
      if (s[year]?.val != null) row[field] = s[year].val
    }
    return row
  })
}

export default async function handler(req, res) {
  const ticker = String(req.query?.ticker || '').trim().toUpperCase()
  if (!ticker) { res.status(400).json({ error: 'ticker required' }); return }
  // US only — Indian tickers use the Screener path.
  if (/\.(NS|BO)$/i.test(ticker)) { res.status(200).json({ error: 'not a US ticker' }); return }

  try {
    const cik = await getCik(ticker)
    if (!cik) { res.status(200).json({ error: `no CIK for ${ticker}` }); return }

    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    })
    if (!r.ok) { res.status(200).json({ error: `SEC companyfacts ${r.status}` }); return }
    const facts = (await r.json())?.facts
    if (!facts) { res.status(200).json({ error: 'no facts' }); return }

    const incomeHistory   = buildRows(facts, CONCEPTS.income)
    const balanceRaw      = buildRows(facts, CONCEPTS.balance)
    const cashflowRaw     = buildRows(facts, CONCEPTS.cashflow)

    // Derive the composite fields the app expects, mirroring Screener's shape.
    const balanceHistory = balanceRaw.map(r0 => {
      const debt = (r0.longTermDebt ?? 0) + (r0.shortTermDebt ?? 0)
      const out = { year: r0.year }
      if (r0.totalAssets        != null) out.totalAssets        = r0.totalAssets
      if (r0.totalEquity        != null) out.totalEquity        = r0.totalEquity
      if (r0.cash               != null) out.cash               = r0.cash
      if (r0.currentAssets      != null) out.currentAssets      = r0.currentAssets
      if (r0.currentLiabilities != null) out.currentLiabilities = r0.currentLiabilities
      if (r0.longTermDebt != null || r0.shortTermDebt != null) out.totalDebt = debt
      return out
    })

    const cashflowHistory = cashflowRaw.map(r0 => {
      const out = { year: r0.year }
      if (r0.operatingCF != null) out.operatingCF = r0.operatingCF
      if (r0.capex       != null) out.capex       = r0.capex
      // FCF = OCF - capex (capex is filed as a positive outflow)
      if (r0.operatingCF != null && r0.capex != null) out.freeCashFlow = r0.operatingCF - r0.capex
      return out
    })

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate')
    res.status(200).json({
      ticker, cik,
      incomeHistory, balanceHistory, cashflowHistory,
      years: incomeHistory.length,
      source: 'sec',
    })
  } catch (e) {
    // Never throw — the caller falls back to Yahoo-only, i.e. today's behaviour.
    res.status(200).json({ error: String(e?.message || e) })
  }
}