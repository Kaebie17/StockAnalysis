
/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * yahoo-finance2 returns clean JS objects — no {raw, fmt} wrappers.
 * Dates are JS Date objects. Values are direct numbers.
 *
 * ALL values stored with resolution metadata: { value, status, formula }
 */

/**
 * Fill remaining holes in the LATEST year from figures the user pulled out of a
 * filing. Documents sit BEHIND Yahoo/Screener/SEC — they are the last resort, for
 * metrics no automatic source carried. Nothing here overwrites a real value.
 *
 * Before this, an AR number had nowhere to go: the only one wired up was material
 * cost, and even that only reached the Block 5 margin trend, never the dashboard.
 * The reader would ask you for cash, you'd give it, and it vanished.
 *
 * @param arData  state.arData — the reconciled slot store
 */
export function applyDocFacts(data, arData) {
  const slots = arData?.slots || arData
  if (!data || !slots) return data

  const scale = (data.currency === 'INR') ? 1e7 : 1   // AR figures are in Crore
  const TARGETS = {
    income:   ['cogs', 'grossProfit', 'revenue', 'operatingProfit', 'depreciation', 'interest', 'netProfit'],
    balance:  ['cash', 'totalDebt', 'totalEquity', 'totalAssets'],
    cashflow: ['capex', 'operatingCF', 'freeCashFlow'],
  }
  const HISTORY = { income: 'incomeHistory', balance: 'balanceHistory', cashflow: 'cashflowHistory' }

  const out = { ...data }
  let filled = 0
  for (const [table, fields] of Object.entries(TARGETS)) {
    const key  = HISTORY[table]
    const rows = out[key]
    if (!rows?.length) continue
    const last = { ...rows[rows.length - 1] }
    for (const f of fields) {
      const v = slots[f]?.value
      if (v == null) continue
      if (last[f]?.value != null) continue          // a real source already has it
      last[f] = {
        value: v * scale,
        status: 'document',
        formula: `From filing (${slots[f].asOf || 'annual report'})`,
      }
      filled++
    }
    out[key] = [...rows.slice(0, -1), last]
  }
  if (filled > 0) out.docFilled = filled
  return out
}

export function normalize(source, raw) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  if (source === 'sec-merged') return normalizeSecMerged(raw)
  if (source === 'csv')      return raw
  throw new Error(`Unknown source: ${source}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CR = 1e7  // Crore to absolute INR

function src(value)              { return { value, status: 'source',       formula: null } }
function derived(value, formula) { return { value, status: 'derived',      formula } }
function ttm(value)              { return { value, status: 'ttm',          formula: 'TTM' } }
function unavailable()           { return { value: null, status: 'unavailable', formula: null } }
function scaleCr(tagged) {
  if (!tagged || tagged.value == null) return tagged ?? unavailable()
  return { ...tagged, value: tagged.value * CR }
}
function n(v) { return typeof v === 'number' && isFinite(v) ? v : null }
function yearOf(d) {
  if (!d) return null
  if (d instanceof Date) return isNaN(d) ? null : d.getFullYear().toString()
  if (typeof d === 'number') return new Date(d * 1000).getFullYear().toString()
  // Over the wire the API sends JSON, so Date values arrive as ISO STRINGS
  // ("2026-03-31T00:00:00.000Z"). Without this branch every FTS row's year
  // resolved to null, ftsYears came out empty, and normalize fell back to the
  // synthetic single-year row — the root cause of "1yr" + missing metrics.
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-\d{2}-\d{2}/)          // ISO date
    if (m) return m[1]
    const m2 = d.match(/\b(19|20)\d{2}\b/)             // any 4-digit year fallback
    if (m2) return m2[0]
    const parsed = new Date(d)
    return isNaN(parsed) ? null : parsed.getFullYear().toString()
  }
  return null
}

// ─── Yahoo normalizer (yahoo-finance2 output) ─────────────────────────────────

function normalizeYahoo({ ticker, quote, summary, history, fts }) {
  const q   = quote    || {}
  const fin = summary?.financialData      || {}
  const ks  = summary?.defaultKeyStatistics || {}
  const sd  = summary?.summaryDetail      || {}
  const ap  = summary?.assetProfile       || {}

  // ── Currency & price ────────────────────────────────────────────────────────
  const currency  = q.currency || 'USD'
  const price     = n(q.regularMarketPrice)
  const marketCap = n(q.marketCap)
  const shares    = n(q.sharesOutstanding) ?? n(ks.sharesOutstanding)

  // ── Price history (from historical()) ────────────────────────────────────────
  // yahoo-finance2 historical() returns [{date, open, high, low, close, adjClose, volume}]
  // adjClose is already adjusted — use it for accurate technicals
  const priceHistory = (history || [])
    .filter(d => d.adjClose != null || d.close != null)
    .map(d => ({
      date:   d.date instanceof Date
                ? d.date.toISOString().slice(0, 10)
                : new Date(d.date).toISOString().slice(0, 10),
      open:   n(d.open),
      high:   n(d.high),
      low:    n(d.low),
      close:  n(d.adjClose) ?? n(d.close),
      volume: n(d.volume)
    }))

  // ── Statement history (from fundamentalsTimeSeries) ───────────────────────────
  // MIGRATED: quoteSummary's incomeStatementHistory/balanceSheetHistory/
  // cashflowStatementHistory have been dead since Nov 2024 (confirmed by
  // yahoo-finance2's own runtime warning). fundamentalsTimeSeries is the
  // current replacement, returning one entry per fiscal-year date with
  // requested "type" fields flattened directly onto each entry.
  //
  // Field naming is a best-effort match against Yahoo's concept taxonomy —
  // each metric below tries multiple alias candidates since the exact
  // names returned haven't been verified against live data yet. The
  // DIAGNOSTIC log in api/yahoo.js shows the real keys on first deploy;
  // update the candidate lists here if any come back empty.
  const ftsRows = Array.isArray(fts) ? fts : []

  const pick = (row, ...candidates) => {
    for (const c of candidates) {
      const v = n(row[c])
      if (v != null) return v
    }
    return null
  }

  const dateOf = row => row.date || row.asOfDate || row.endDate
  const ftsYears = [...new Set(ftsRows.map(r => yearOf(dateOf(r))).filter(Boolean))].sort()

  const incomeHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    // yahoo-finance2 returns concept keys with the period prefix STRIPPED
    // (annualTotalRevenue -> totalRevenue, etc). These are those real keys.
    const rev = pick(row, 'totalRevenue', 'operatingRevenue')
    const opI = pick(row, 'operatingIncome', 'totalOperatingIncomeAsReported', 'EBIT')
    const dep = pick(row, 'reconciledDepreciation', 'depreciationAndAmortizationInIncomeStatement',
                          'depreciationAmortizationDepletionIncomeStatement', 'depreciationIncomeStatement')
    const int = pick(row, 'interestExpense', 'interestExpenseNonOperating', 'netNonOperatingInterestIncomeExpense')
    const ni  = pick(row, 'netIncome', 'netIncomeCommonStockholders')
    const epsVal = pick(row, 'dilutedEPS', 'basicEPS')
    const ebd = pick(row, 'EBITDA', 'normalizedEBITDA')
    // fundamentalsTimeSeries is requested with module:'all', so gross profit and
    // cost of revenue ARE in the payload. They were previously hard-coded
    // unavailable — a leftover stub from the fts migration, not a decision.
    const gp  = pick(row, 'grossProfit')
    const cog = pick(row, 'costOfRevenue', 'reconciledCostOfRevenue')
    return {
      year,
      revenue:         rev != null ? src(rev) : unavailable(),
      expenses:        unavailable(),
      grossProfit:     gp  != null ? src(gp)  : unavailable(),
      cogs:            cog != null ? src(cog) : unavailable(),
      operatingProfit: opI != null ? src(opI) : unavailable(),
      ebitda:          ebd != null ? src(ebd) : unavailable(), // else derived later in ratios.js
      depreciation:    dep != null ? src(dep) : unavailable(),
      interest:        int != null ? src(int) : unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ni  != null ? src(ni)  : unavailable(),
      eps:             epsVal != null ? src(epsVal) : unavailable(),
    }
  }).filter(r => r.year && r.revenue.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // Backfill from Yahoo's earnings module (annual). IMPORTANT: in
  // financialsChart.yearly, `earnings` is NET INCOME (absolute currency), NOT
  // EPS. Assigning it to eps produced garbage EPS/P/E/Graham/fair-value. Use it
  // only to fill a missing Net Profit; real EPS is derived (Net Profit ÷ Shares)
  // in ratios.js.
  for (const e of (summary?.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => r.year === String(e.date))
    if (row && row.netProfit.value == null && e.earnings != null) row.netProfit = src(n(e.earnings))
  }

  const balanceHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    const ta  = pick(row, 'totalAssets')
    const eq  = pick(row, 'stockholdersEquity', 'totalEquityGrossMinorityInterest', 'commonStockEquity')
    const ltd = pick(row, 'totalDebt', 'longTermDebt', 'longTermDebtAndCapitalLeaseObligation')
    // Cash was hard-coded unavailable — same leftover stub as grossProfit above.
    const csh = pick(row, 'cashAndCashEquivalents', 'cashCashEquivalentsAndShortTermInvestments',
                          'endCashPosition', 'cashAndCashEquivalentsAtCarryingValue')
    const ca  = pick(row, 'currentAssets', 'totalCurrentAssets')
    const cl  = pick(row, 'currentLiabilities', 'totalCurrentLiabilities')
    return {
      year,
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      eq  != null ? src(eq)  : unavailable(),
      // NEVER default to src(0): a fabricated zero tagged 'source' understated
      // capital employed (inflating ROCE) and corrupted netDebt/EV.
      totalDebt:        ltd != null ? src(ltd) : unavailable(),
      cash:             csh != null ? src(csh) : unavailable(),
      totalAssets:      ta  != null ? src(ta)  : unavailable(),
      totalLiabilities: unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
      currentAssets:    ca  != null ? src(ca)  : unavailable(),
      currentLiabilities: cl != null ? src(cl) : unavailable(),
    }
  }).filter(r => r.year && r.totalAssets.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  const cashflowHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    const opCF = pick(row, 'operatingCashFlow', 'cashFlowFromContinuingOperatingActivities')
    const fcf  = pick(row, 'freeCashFlow')
    // capitalExpenditure is in the fts payload and was never picked up. Yahoo
    // files it as a NEGATIVE outflow; store the absolute magnitude so every
    // source agrees on sign (SEC files it positive).
    const cxRaw = pick(row, 'capitalExpenditure', 'netPPEPurchaseAndSale', 'purchaseOfPPE')
    const cx    = cxRaw != null ? Math.abs(cxRaw) : null
    return {
      year,
      operatingCF:  opCF != null ? src(opCF) : unavailable(),
      investingCF:  unavailable(),
      financingCF:  unavailable(),
      capex:        cx != null ? src(cx) : unavailable(),
      // Real FCF only. The old `opCF x 0.7` proxy invented a 30%-of-OCF capex
      // assumption and fed it to fcfYield / fcfConversion / DCF / reverse-DCF.
      // If capex is genuinely unknown, FCF is unknown — say so.
      freeCashFlow: fcf  != null ? src(fcf)
                  : (opCF != null && cx != null)
                      ? derived(opCF - cx, 'Operating CF − CapEx')
                      : unavailable(),
    }
  }).filter(r => r.year && r.operatingCF.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // ── TTM from financialData ────────────────────────────────────────────────────
  // yahoo-finance2 financialData fields are direct numbers (no .raw wrapper)
  const ttmData = {
    revenue:          n(fin.totalRevenue)      != null ? src(n(fin.totalRevenue))      : unavailable(),
    grossProfit:      n(fin.grossProfits)      != null ? src(n(fin.grossProfits))      : unavailable(),
    ebitda:           n(fin.ebitda)            != null ? ttm(n(fin.ebitda))            : unavailable(),
    netProfit:        n(fin.netIncomeToCommon) != null ? src(n(fin.netIncomeToCommon)) : unavailable(),
    eps:              n(fin.trailingEps) ?? n(ks.trailingEps)
                        ? src(n(fin.trailingEps) ?? n(ks.trailingEps))              : unavailable(),
    operatingCF:      n(fin.operatingCashflow)  != null ? src(n(fin.operatingCashflow)) : unavailable(),
    freeCashFlow:     n(fin.freeCashflow)        != null ? src(n(fin.freeCashflow))      : unavailable(),
    totalDebt:        n(fin.totalDebt)           != null ? src(n(fin.totalDebt))         : unavailable(),
    cash:             n(fin.totalCash)           != null ? src(n(fin.totalCash))         : unavailable(),
    grossMargins:     n(fin.grossMargins)        != null ? ttm(n(fin.grossMargins))      : unavailable(),
    profitMargins:    n(fin.profitMargins)       != null ? ttm(n(fin.profitMargins))     : unavailable(),
    ebitdaMargins:    n(fin.ebitdaMargins)       != null ? ttm(n(fin.ebitdaMargins))     : unavailable(),
    operatingMargins: n(fin.operatingMargins)    != null ? ttm(n(fin.operatingMargins))  : unavailable(),
    roe:              n(fin.returnOnEquity)       != null ? ttm(n(fin.returnOnEquity))    : unavailable(),
    debtToEquity:     n(fin.debtToEquity)        != null ? ttm(n(fin.debtToEquity))      : unavailable(),
    currentRatio:     n(fin.currentRatio)        != null ? ttm(n(fin.currentRatio))      : unavailable(),
    revenueGrowth:    n(fin.revenueGrowth)       != null ? ttm(n(fin.revenueGrowth))     : unavailable(),
    earningsGrowth:   n(fin.earningsGrowth)      != null ? ttm(n(fin.earningsGrowth))    : unavailable(),
  }

  // ── Synthesize from TTM when statement history is sparse ─────────────────────
  // yahoo-finance2 sometimes returns limited statement history for Indian stocks
  // Use TTM financialData fields to fill gaps
  const ttmRev  = ttmData.revenue.value
  const ttmEb   = ttmData.ebitda.value
  const ttmNP   = ttmData.netProfit.value
  const ttmEps  = ttmData.eps.value
  const ttmDebt = ttmData.totalDebt.value
  const ttmCash = ttmData.cash.value
  const ttmROE  = ttmData.roe.value
  const ttmDE   = ttmData.debtToEquity.value
  const ttmOpCF = ttmData.operatingCF.value
  const ttmFCF  = ttmData.freeCashFlow.value
  const ttmOpM  = ttmData.operatingMargins.value

  if (incomeHistory.length === 0 && (ttmRev || ttmNP)) {
    const yr = new Date().getFullYear().toString()
    incomeHistory.push({
      year:            yr,
      synthetic:       true,   // TTM-only stub — must never shadow real/pasted rows
      revenue:         ttmRev  != null ? src(ttmRev)  : unavailable(),
      expenses:        unavailable(),
      grossProfit:     ttmData.grossProfit.value != null ? src(ttmData.grossProfit.value) : unavailable(),
      cogs:            unavailable(),
      operatingProfit: ttmRev && ttmOpM ? derived(ttmRev * ttmOpM, 'Revenue × Op.Margin (TTM)') : unavailable(),
      ebitda:          ttmEb   != null ? ttm(ttmEb)   : unavailable(),
      depreciation:    unavailable(),
      interest:        unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ttmNP   != null ? src(ttmNP)   : unavailable(),
      eps:             ttmEps  != null ? src(ttmEps)  : unavailable(),
    })
  }

  if (balanceHistory.length === 0 && (ttmDebt != null || ttmDE != null)) {
    const deRatio   = ttmDE != null ? (ttmDE > 10 ? ttmDE / 100 : ttmDE) : null
    const eqFromDE  = ttmDebt != null && deRatio ? ttmDebt / deRatio : null
    const eqFromROE = ttmNP && ttmROE && ttmROE > 0 ? ttmNP / ttmROE : null
    const equity    = eqFromDE ?? eqFromROE
    const yr        = new Date().getFullYear().toString()
    balanceHistory.push({
      year:             yr,
      synthetic:        true,   // TTM-only stub — must never shadow real/pasted rows
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      equity  != null ? derived(equity, deRatio ? 'Debt ÷ D/E (TTM)' : 'Net Profit ÷ ROE (TTM)') : unavailable(),
      totalDebt:        ttmDebt != null ? src(ttmDebt) : unavailable(),
      cash:             ttmCash != null ? src(ttmCash) : unavailable(),
      totalAssets:      unavailable(),
      totalLiabilities: unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
      currentAssets:    unavailable(),
      currentLiabilities: unavailable(),
    })
  }

  if (cashflowHistory.length === 0 && (ttmOpCF || ttmFCF)) {
    const yr = new Date().getFullYear().toString()
    cashflowHistory.push({
      year:         yr,
      synthetic:    true,   // TTM-only stub — must never shadow real/pasted rows
      operatingCF:  ttmOpCF != null ? src(ttmOpCF) : unavailable(),
      investingCF:  unavailable(),
      financingCF:  unavailable(),
      capex:        unavailable(),
      freeCashFlow: ttmFCF  != null ? src(ttmFCF) : unavailable(),
    })
  }

  return {
    ticker,
    name:     q.longName || q.shortName || ticker,
    source:   'yahoo',
    deepSource: null,        // 'screener' | 'sec' once a deep source merges in
    currency,
    price,
    marketCap,
    shares,
    priceHistory,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm: ttmData,
    meta: {
      sector:    ap.sector    || null,
      industry:  ap.industry  || null,
      website:   ap.website   || null,
      exchange:  q.exchange   || null,
      pe:        n(q.trailingPE)   ?? n(sd.trailingPE),
      pb:        n(q.priceToBook)  ?? n(ks.priceToBook),
      divYield:  n(q.trailingAnnualDividendYield) ?? n(sd.dividendYield),
      beta:      n(q.beta)         ?? n(sd.beta),
      high52:    n(q.fiftyTwoWeekHigh)  ?? n(sd.fiftyTwoWeekHigh),
      low52:     n(q.fiftyTwoWeekLow)   ?? n(sd.fiftyTwoWeekLow),
      avgVolume: n(q.averageDailyVolume3Month) ?? n(sd.averageVolume),
      change1d:  n(q.regularMarketChangePercent) ?? null,
      volume:    n(q.regularMarketVolume) ?? null,
    },
    sourceStats: {}
  }
}

// ─── Screener normalizer (unchanged) ─────────────────────────────────────────

function normalizeScreener(raw) {
  const inc = (raw.incomeHistory  || []).map(r => ({
    year:            r.year,
    revenue:         scaleCr(r.revenue),
    expenses:        scaleCr(r.expenses),
    operatingProfit: scaleCr(r.operatingProfit),
    ebitda:          scaleCr(r.ebitda),
    depreciation:    scaleCr(r.depreciation),
    interest:        scaleCr(r.interest),
    otherIncome:     scaleCr(r.otherIncome),
    netProfit:       scaleCr(r.netProfit),
    eps:             r.eps ?? unavailable(),
    grossProfit:     unavailable(),   // Indian P&L has no gross-profit line...
    // ...but the Expenses "+" gives Material Cost, which the parser has already
    // converted from % of sales to an absolute figure. ratios.js turns it into
    // gross profit. Was hard-coded unavailable, which binned the user's expand.
    cogs:            scaleCr(r.cogs),
  }))
  const bal = (raw.balanceHistory || []).map(r => ({
    year:             r.year,
    equityCapital:    scaleCr(r.equityCapital),
    reserves:         scaleCr(r.reserves),
    totalEquity:      scaleCr(r.totalEquity),
    totalDebt:        scaleCr(r.totalDebt),
    totalAssets:      scaleCr(r.totalAssets),
    totalLiabilities: scaleCr(r.totalLiabilities),
    fixedAssets:      scaleCr(r.fixedAssets),
    investments:      scaleCr(r.investments),
    cash:             scaleCr(r.cash),   // Other Assets "+" -> Cash Equivalents
    currentAssets:      unavailable(),
    currentLiabilities: unavailable(),
  }))
  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  scaleCr(r.operatingCF),
    investingCF:  scaleCr(r.investingCF),
    financingCF:  scaleCr(r.financingCF),
    capex:        scaleCr(r.capex),   // Investing "+" -> Fixed assets purchased
    freeCashFlow: scaleCr(r.freeCashFlow),
  }))

  const ks       = raw.keyStats || {}
  const price    = ks['currentprice']?.value ?? null
  const mcapCr   = ks['marketcap']?.value    ?? null
  const marketCap = mcapCr != null ? mcapCr * CR : null

  const latestInc = inc[inc.length - 1] || {}
  const latestBal = bal[bal.length - 1] || {}
  const latestCF  = cf[cf.length - 1]  || {}

  return {
    ticker:   raw.ticker,
    name:     raw.name || raw.ticker,
    source:   'screener',
    deepSource: null,
    currency: 'INR',
    price,
    marketCap,
    shares:   null,
    priceHistory: [],
    incomeHistory:  inc,
    balanceHistory: bal,
    cashflowHistory: cf,
    ttm: {
      revenue:       latestInc.revenue,
      netProfit:     latestInc.netProfit,
      ebitda:        latestInc.ebitda,
      operatingCF:   latestCF.operatingCF,
      freeCashFlow:  latestCF.freeCashFlow,
      totalDebt:     latestBal.totalDebt,
      grossMargins:  unavailable(),
      profitMargins: unavailable(),
      ebitdaMargins: unavailable(),
    },
    meta: {
      sector: null, industry: null, website: null, exchange: 'NSE/BSE',
      pe: ks['stockpe']?.value ?? null,
      pb: null, divYield: ks['dividendyield']?.value ?? null,
    },
    keyStats: raw.keyStats,
    sourceStats: raw.keyStats || {},
    parserStatus: raw.parserStatus
  }
}

// ─── Merged normalizer ────────────────────────────────────────────────────────


/**
 * THE merge. Used by both deep sources — Screener (India) and SEC (US).
 *
 * Yahoo is a taster: it exists so the first search isn't a screen of empty boxes,
 * and so a ticker nobody has fed still shows something. The moment a real source
 * covers a year, Yahoo stops being the answer for that year.
 *
 *   - Deep source wins every year it covers, FIELD BY FIELD.
 *   - Yahoo fills only what the deep source doesn't carry (cash, EBITDA, gross
 *     profit on the Indian path — things Screener has no row for).
 *   - Years no deep source reaches stay pure Yahoo.
 *
 * This replaces "Yahoo always wins overlapping years", which spliced two sources
 * mid-series: Screener for the old years, Yahoo for the recent ones, and a seam
 * in the middle carrying every restatement and basis change — directly under the
 * 10-year CAGR. One basis per series now.
 *
 * There is no numeric gate. Screener and SEC both win every year they carry. A
 * paste that reaches here has already passed the structural check in the parser
 * (right table, annual not quarterly) and nothing else needs to be true of it.
 */
function mergeDeep(yahooRows, deepRows, fields) {
  const byYear = {}

  for (const r of (yahooRows || [])) {
    if (r?.year) byYear[r.year] = r
  }

  for (const d of (deepRows || [])) {
    if (!d?.year) continue
    const year = String(d.year)
    const y = byYear[year]
    if (!y) { byYear[year] = d; continue }

    const out = { ...y, ...d }                 // deep source wins the shape
    if (y.synthetic) delete out.synthetic      // real data replaced the stub
    for (const f of fields) {
      if (d[f]?.value != null) { out[f] = d[f]; continue }
      // Deep source has no value here. Keep Yahoo's, labelled as a fill.
      if (y[f]?.value != null) {
        out[f] = { ...y[f], status: 'cross-source', formula: `From Yahoo (deep source has no ${f})` }
      } else {
        out[f] = y[f] ?? d[f] ?? unavailable()
      }
    }
    byYear[year] = out
  }
  return Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year))
}

const INCOME_F  = ['revenue', 'expenses', 'grossProfit', 'cogs', 'operatingProfit', 'ebitda',
                   'depreciation', 'interest', 'otherIncome', 'netProfit', 'eps']
const BALANCE_F = ['equityCapital', 'reserves', 'totalEquity', 'totalDebt', 'cash', 'totalAssets',
                   'totalLiabilities', 'fixedAssets', 'investments',
                   'currentAssets', 'currentLiabilities']
const CF_F      = ['operatingCF', 'investingCF', 'financingCF', 'capex', 'freeCashFlow']

function normalizeMerged({ yahoo, screener }) {
  const y = normalizeYahoo(yahoo)
  const sc = normalizeScreener(screener)

  const incomeHistory   = mergeDeep(y.incomeHistory,   sc.incomeHistory,   INCOME_F)
  const balanceHistory  = mergeDeep(y.balanceHistory,  sc.balanceHistory,  BALANCE_F)
  const cashflowHistory = mergeDeep(y.cashflowHistory, sc.cashflowHistory, CF_F)

  const used = sc.incomeHistory?.length || 0
  return {
    ...y,                                   // price, mcap, shares, priceHistory, beta, TTM
    source:       used > 0 ? 'merged' : 'yahoo',
    deepSource:   used > 0 ? 'screener' : null,
    historyYears: incomeHistory.length - (y.incomeHistory?.length || 0),
    incomeHistory,
    balanceHistory,
    cashflowHistory,
  }
}


function mergeByYear(yArr, sArr, mergeFn) {
  const map = {}
  for (const r of (sArr || [])) if (r.year) map[r.year] = r
  for (const r of (yArr || [])) {
    if (!r.year) continue
    map[r.year] = map[r.year] ? mergeFn(r, map[r.year]) : r
  }
  return Object.values(map).sort((a, b) => a.year.localeCompare(b.year))
}

function mergeIncomeRow(y, s) {
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year,
    revenue:         pick(y.revenue,         s.revenue,         'revenue'),
    expenses:        pick(y.expenses,        s.expenses,        'expenses'),
    grossProfit:     pick(y.grossProfit,     s.grossProfit,     'grossProfit'),
    operatingProfit: pick(y.operatingProfit, s.operatingProfit, 'operatingProfit'),
    ebitda:          pick(y.ebitda,          s.ebitda,          'ebitda'),
    depreciation:    pick(y.depreciation,    s.depreciation,    'depreciation'),
    interest:        pick(y.interest,        s.interest,        'interest'),
    otherIncome:     pick(y.otherIncome,     s.otherIncome,     'otherIncome'),
    netProfit:       pick(y.netProfit,       s.netProfit,       'netProfit'),
    eps:             pick(y.eps,             s.eps,             'eps'),
  }
}

function mergeBalanceRow(y, s) {
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year,
    equityCapital:    pick(y.equityCapital,    s.equityCapital,    'equityCapital'),
    reserves:         pick(y.reserves,         s.reserves,         'reserves'),
    totalEquity:      pick(y.totalEquity,      s.totalEquity,      'totalEquity'),
    totalDebt:        pick(y.totalDebt,        s.totalDebt,        'totalDebt'),
    cash:             pick(y.cash,             s.cash,             'cash'),
    totalAssets:      pick(y.totalAssets,      s.totalAssets,      'totalAssets'),
    totalLiabilities: pick(y.totalLiabilities, s.totalLiabilities, 'totalLiabilities'),
    fixedAssets:      pick(y.fixedAssets,      s.fixedAssets,      'fixedAssets'),
    investments:      pick(y.investments,      s.investments,      'investments'),
  }
}

function mergeCFRow(y, s) {
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year,
    operatingCF:  pick(y.operatingCF,  s.operatingCF,  'operatingCF'),
    investingCF:  pick(y.investingCF,  s.investingCF,  'investingCF'),
    financingCF:  pick(y.financingCF,  s.financingCF,  'financingCF'),
    freeCashFlow: pick(y.freeCashFlow, s.freeCashFlow, 'freeCashFlow'),
  }
}

function mergeTTM(y, s) {
  if (!y) return s
  if (!s) return y
  const out = { ...y }
  for (const k of Object.keys(s ?? {})) {
    if (out[k]?.value == null && s[k]?.value != null) out[k] = s[k]
  }
  return out
}


// ── SEC (US tickers) ─────────────────────────────────────────────────────────
// SEC EDGAR fills the same slot Screener fills for Indian tickers: deep annual
// history. Yahoo still supplies price / marketCap / priceHistory / meta / ttm.
//
// Same merge contract as normalizeMerged: Yahoo ALWAYS wins for overlapping
// years; SEC only contributes years Yahoo doesn't have (pre-Yahoo history). No
// validation list is needed — SEC is the primary filing source, not a scrape.
//
// raw = { yahoo, sec } where sec = { incomeHistory, balanceHistory, cashflowHistory }
// with PLAIN NUMBER fields; we tag them here to match the app's row shape.
function normalizeSecMerged({ yahoo, sec }) {
  const y = normalizeYahoo(yahoo)
  if (!sec || sec.error) return y

  const tagRow = (row, fields) => {
    const out = { year: String(row.year) }
    for (const f of fields) out[f] = row[f] != null ? src(row[f]) : unavailable()
    return out
  }
  const secYears = (sec.incomeHistory || []).map(r => String(r.year))
  const tag = (rows, fields) => (rows || []).map(r => tagRow(r, fields))

  const incomeHistory   = mergeDeep(y.incomeHistory,   tag(sec.incomeHistory,   INCOME_F),  INCOME_F)
  const balanceHistory  = mergeDeep(y.balanceHistory,  tag(sec.balanceHistory,  BALANCE_F), BALANCE_F)
  const cashflowHistory = mergeDeep(y.cashflowHistory, tag(sec.cashflowHistory, CF_F),      CF_F)

  return {
    ...y,
    source:       secYears.length > 0 ? 'merged' : 'yahoo',
    deepSource:   'sec',
    historyYears: incomeHistory.length - (y.incomeHistory?.length || 0),
    incomeHistory,
    balanceHistory,
    cashflowHistory,
  }
}

