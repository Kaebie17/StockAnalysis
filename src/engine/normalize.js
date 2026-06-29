/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * yahoo-finance2 returns clean JS objects — no {raw, fmt} wrappers.
 * Dates are JS Date objects. Values are direct numbers.
 *
 * ALL values stored with resolution metadata: { value, status, formula }
 */

export function normalize(source, raw, validHistoricalYears = null) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw, validHistoricalYears)
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
  if (d instanceof Date) return d.getFullYear().toString()
  if (typeof d === 'number') return new Date(d * 1000).getFullYear().toString()
  return null
}

// ─── Yahoo normalizer (yahoo-finance2 output) ─────────────────────────────────

function normalizeYahoo({ ticker, quote, summary, history }) {
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

  // ── Income history (from incomeStatementHistory) ──────────────────────────────
  // yahoo-finance2 returns direct numbers, endDate is a Date object
  const incStmt = summary?.incomeStatementHistory?.incomeStatementHistory || []
  const incomeHistory = incStmt.map(s => {
    const rev  = n(s.totalRevenue)
    const gp   = n(s.grossProfit)
    const opI  = n(s.operatingIncome) ?? n(s.ebit)
    const ni   = n(s.netIncome)
    const int  = n(s.interestExpense)
    return {
      year:            yearOf(s.endDate),
      revenue:         rev  != null ? src(rev)  : unavailable(),
      expenses:        unavailable(),
      grossProfit:     gp   != null ? src(gp)   : unavailable(),
      operatingProfit: opI  != null ? src(opI)  : unavailable(),
      ebitda:          unavailable(), // derived later in ratios.js from opI + dep
      depreciation:    unavailable(), // not in Yahoo income statement
      interest:        int  != null ? src(int)  : unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ni   != null ? src(ni)   : unavailable(),
      eps:             unavailable(), // from earnings module below
    }
  }).filter(r => r.year && r.revenue.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // EPS from earnings module (annual)
  for (const e of (summary?.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => r.year === String(e.date))
    if (row && e.earnings != null) row.eps = src(n(e.earnings))
  }

  // ── Balance history (from balanceSheetHistory) ───────────────────────────────
  const bsStmt = summary?.balanceSheetHistory?.balanceSheetStatements || []
  const balanceHistory = bsStmt.map(s => {
    const ta   = n(s.totalAssets)
    const eq   = n(s.totalStockholderEquity)
    const ltd  = n(s.longTermDebt) ?? n(s.shortLongTermDebt)
    const cash = n(s.cash) ?? n(s.cashAndCashEquivalents)
    const tl   = n(s.totalLiab)
    return {
      year:             yearOf(s.endDate),
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      eq   != null ? src(eq)   : unavailable(),
      totalDebt:        ltd  != null ? src(ltd)  : src(0),
      cash:             cash != null ? src(cash) : src(0),
      totalAssets:      ta   != null ? src(ta)   : unavailable(),
      totalLiabilities: tl   != null ? src(tl)   : unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
    }
  }).filter(r => r.year && r.totalAssets.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // ── Cash flow history (from cashflowStatementHistory) ────────────────────────
  const cfStmt = summary?.cashflowStatementHistory?.cashflowStatements || []
  const cashflowHistory = cfStmt.map(s => {
    const opCF  = n(s.totalCashFromOperatingActivities)
    const invCF = n(s.totalCashflowsFromInvestingActivities)
    const finCF = n(s.totalCashFromFinancingActivities)
    const capex = n(s.capitalExpenditures)
    const fcf   = n(s.freeCashFlow)
    const fcfDerived = opCF != null && capex != null
      ? opCF - Math.abs(capex) : null
    return {
      year:         yearOf(s.endDate),
      operatingCF:  opCF  != null ? src(opCF)  : unavailable(),
      investingCF:  invCF != null ? src(invCF) : unavailable(),
      financingCF:  finCF != null ? src(finCF) : unavailable(),
      freeCashFlow: fcf   != null ? src(fcf)
                  : fcfDerived != null ? derived(fcfDerived, 'Operating CF − |CapEx|')
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
      revenue:         ttmRev  != null ? src(ttmRev)  : unavailable(),
      expenses:        unavailable(),
      grossProfit:     ttmData.grossProfit.value != null ? src(ttmData.grossProfit.value) : unavailable(),
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
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      equity  != null ? derived(equity, deRatio ? 'Debt ÷ D/E (TTM)' : 'Net Profit ÷ ROE (TTM)') : unavailable(),
      totalDebt:        ttmDebt != null ? src(ttmDebt) : unavailable(),
      cash:             ttmCash != null ? src(ttmCash) : unavailable(),
      totalAssets:      unavailable(),
      totalLiabilities: unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
    })
  }

  if (cashflowHistory.length === 0 && (ttmOpCF || ttmFCF)) {
    const yr = new Date().getFullYear().toString()
    cashflowHistory.push({
      year:         yr,
      operatingCF:  ttmOpCF != null ? src(ttmOpCF) : unavailable(),
      investingCF:  unavailable(),
      financingCF:  unavailable(),
      freeCashFlow: ttmFCF  != null ? src(ttmFCF)
                  : ttmOpCF != null ? derived(ttmOpCF * 0.7, 'Operating CF × 0.7 (proxy)')
                  : unavailable(),
    })
  }

  return {
    ticker,
    name:     q.longName || q.shortName || ticker,
    source:   'yahoo',
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
    grossProfit:     unavailable(),
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
    cash:             unavailable(),
  }))
  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  scaleCr(r.operatingCF),
    investingCF:  scaleCr(r.investingCF),
    financingCF:  scaleCr(r.financingCF),
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

function normalizeMerged({ yahoo, screener }, validHistoricalYears = null) {
  const y = normalizeYahoo(yahoo)
  const s = normalizeScreener(screener)

  // Only use Screener rows for years that:
  // 1. Are NOT in Yahoo (pre-Yahoo historical years)
  // 2. Have passed validation (validHistoricalYears list)
  // Yahoo ALWAYS wins for overlapping years — never override with Screener
  const filterScreener = (rows) => {
    if (!rows) return []
    if (!validHistoricalYears || validHistoricalYears.length === 0) return []
    return rows.filter(r => validHistoricalYears.includes(r.year))
  }

  // Merge: Yahoo years first, then append validated Screener pre-Yahoo years
  const mergeHistorical = (yArr, sArr, mergeFn) => {
    const yahooRows    = yArr || []
    const screenerRows = filterScreener(sArr)
    // No overlap possible since screenerRows are pre-Yahoo years only
    return [...screenerRows, ...yahooRows].sort((a, b) => a.year.localeCompare(b.year))
  }

  const income   = mergeHistorical(y.incomeHistory,   s.incomeHistory,   mergeIncomeRow)
  const balance  = mergeHistorical(y.balanceHistory,  s.balanceHistory,  mergeBalanceRow)
  const cashflow = mergeHistorical(y.cashflowHistory, s.cashflowHistory, mergeCFRow)

  const histYears = validHistoricalYears?.length || 0

  return {
    ...y,
    source:         histYears > 0 ? 'merged' : 'yahoo',
    historyYears:   histYears,  // how many extra years Screener added
    price:          y.price     ?? s.price,
    marketCap:      y.marketCap ?? s.marketCap,
    incomeHistory:  income,
    balanceHistory: balance,
    cashflowHistory: cashflow,
    ttm:            mergeTTM(y.ttm, s.ttm),
    sourceStats:    s.keyStats ?? {}
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
