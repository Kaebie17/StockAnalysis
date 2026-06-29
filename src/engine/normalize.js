/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * ALL values stored with resolution metadata: { value, status, formula }
 *   status: 'source' | 'derived' | 'positional' | 'cross-source' | 'ttm' | 'unavailable'
 *
 * The engine (ratios.js, valuation.js) reads .value from each field.
 * The UI reads .status and .formula for tooltips/badges.
 *
 * Numbers from Screener are in CRORES. We store them as-is in Crores for INR.
 * Numbers from Yahoo are in absolute units (INR or USD).
 * normalize.js converts everything to absolute units: Crores × 1e7.
 */

export function normalize(source, raw) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  if (source === 'csv')      return raw
  throw new Error(`Unknown source: ${source}`)
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

const CR = 1e7  // Crore to absolute INR

function src(value)                      { return { value, status: 'source',       formula: null } }
function derived(value, formula)         { return { value, status: 'derived',      formula } }
function crossSrc(value, srcName)        { return { value, status: 'cross-source', formula: srcName } }
function ttm(value)                      { return { value, status: 'ttm',          formula: 'TTM from financialData' } }
function unavailable()                   { return { value: null, status: 'unavailable', formula: null } }
function best(a, b)                      { return a?.value != null ? a : b }  // prefer a, fallback b

/** Scale a Screener tagged value from Crores to absolute */
function scaleCr(tagged) {
  if (!tagged || tagged.value == null) return tagged ?? unavailable()
  return { ...tagged, value: tagged.value * CR }
}

/** Pull .value safely */
function v(tagged) { return tagged?.value ?? null }

// ─── Merged ───────────────────────────────────────────────────────────────────

function normalizeMerged({ yahoo, screener }) {
  const y = normalizeYahoo(yahoo)
  const s = normalizeScreener(screener)

  // Merge by year — Screener has more years (10yr), Yahoo has 4yr
  const income   = mergeByYear(y.incomeHistory,   s.incomeHistory,   mergeIncomeRow)
  const balance  = mergeByYear(y.balanceHistory,  s.balanceHistory,  mergeBalanceRow)
  const cashflow = mergeByYear(y.cashflowHistory, s.cashflowHistory, mergeCFRow)

  return {
    ...y,
    source: 'merged',
    // Price from Yahoo is authoritative
    price:     y.price     ?? s.price,
    marketCap: y.marketCap ?? s.marketCap,
    incomeHistory:  income,
    balanceHistory: balance,
    cashflowHistory: cashflow,
    // TTM: Yahoo wins, Screener fills gaps
    ttm: mergeTTM(y.ttm, s.ttm),
    // Keep source key stats for reference tooltips
    sourceStats: s.keyStats ?? {}
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
  // Yahoo wins (more precise), Screener fills nulls, mark cross-source
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year,
    revenue:         pick(y.revenue,         s.revenue,         'revenue'),
    expenses:        pick(y.expenses,        s.expenses,        'expenses'),
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
    equityCapital:   pick(y.equityCapital,    s.equityCapital,    'equityCapital'),
    reserves:        pick(y.reserves,         s.reserves,         'reserves'),
    totalEquity:     pick(y.totalEquity,      s.totalEquity,      'totalEquity'),
    totalDebt:       pick(y.totalDebt,        s.totalDebt,        'totalDebt'),
    totalAssets:     pick(y.totalAssets,      s.totalAssets,      'totalAssets'),
    totalLiabilities:pick(y.totalLiabilities, s.totalLiabilities, 'totalLiabilities'),
    fixedAssets:     pick(y.fixedAssets,      s.fixedAssets,      'fixedAssets'),
    investments:     pick(y.investments,      s.investments,      'investments'),
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
  if (!y) return s; if (!s) return y
  const out = { ...y }
  for (const k of Object.keys(s ?? {})) if (out[k]?.value == null && s[k]?.value != null) out[k] = s[k]
  return out
}

// ─── Yahoo normalizer ─────────────────────────────────────────────────────────

function normalizeYahoo({ ticker, chart, quote, fundamentals }) {
  const q7  = quote?.quoteResponse?.result?.[0]      || {}
  const qs  = fundamentals?.quoteSummary?.result?.[0] || {}
  const fin = qs.financialData      || {}
  const ks  = qs.defaultKeyStatistics || {}
  const sd  = qs.summaryDetail      || {}
  const ap  = qs.assetProfile       || {}
  const chartMeta = chart?.chart?.result?.[0]?.meta || {}

  // Currency
  const currency = chartMeta.currency || q7.currency || 'USD'

  // Price — v7 quote most reliable for Indian stocks
  const price     = q7.regularMarketPrice ?? chartMeta.regularMarketPrice ?? rv(fin.currentPrice)
  const marketCap = q7.marketCap          ?? rv(ks.marketCap)
  const shares    = q7.sharesOutstanding  ?? rv(ks.sharesOutstanding)

  // Price history
  const cr     = chart?.chart?.result?.[0]
  const ts     = cr?.timestamp || []
  const ohlcv  = cr?.indicators?.quote?.[0] || {}
  const adj    = cr?.indicators?.adjclose?.[0]?.adjclose || []

  const priceHistory = ts.map((t, i) => ({
    date:   new Date(t * 1000).toISOString().slice(0, 10),
    open:   ohlcv.open?.[i]   ?? null,
    high:   ohlcv.high?.[i]   ?? null,
    low:    ohlcv.low?.[i]    ?? null,
    close:  adj[i] ?? ohlcv.close?.[i] ?? null,
    volume: ohlcv.volume?.[i] ?? null
  })).filter(d => d.close !== null)

  // Income from incomeStatementHistory
  const incStmt = qs.incomeStatementHistory?.incomeStatementHistory || []
  const incomeHistory = incStmt.map(s => {
    const rev  = rv(s.totalRevenue)
    const gp   = rv(s.grossProfit)
    const opI  = rv(s.operatingIncome) ?? rv(s.ebit)
    const ni   = rv(s.netIncome)
    const int  = rv(s.interestExpense)
    return {
      year:            yearOf(rv(s.endDate)),
      revenue:         rev  != null ? src(rev)  : unavailable(),
      expenses:        unavailable(),  // Yahoo doesn't provide expenses line
      grossProfit:     gp   != null ? src(gp)   : unavailable(),
      operatingProfit: opI  != null ? src(opI)  : unavailable(),
      ebitda:          unavailable(),  // will be derived in ratios.js
      depreciation:    unavailable(),  // not in Yahoo income statement
      interest:        int  != null ? src(int)  : unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ni   != null ? src(ni)   : unavailable(),
      eps:             unavailable(),  // from earnings module below
    }
  }).filter(r => r.year && r.revenue.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // EPS from earnings
  for (const e of (qs.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => r.year === String(e.date))
    if (row && e.earnings != null) row.eps = src(rv(e.earnings))
  }

  // Balance from balanceSheetHistory
  const bsStmt = qs.balanceSheetHistory?.balanceSheetStatements || []
  const balanceHistory = bsStmt.map(s => {
    const ta  = rv(s.totalAssets)
    const ltd = rv(s.longTermDebt) ?? rv(s.shortLongTermDebt)
    const eq  = rv(s.totalStockholderEquity)
    const ca  = rv(s.cash) ?? rv(s.cashAndCashEquivalents)
    const tl  = rv(s.totalLiab)
    return {
      year:             yearOf(rv(s.endDate)),
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      eq  != null ? src(eq)  : unavailable(),
      totalDebt:        ltd != null ? src(ltd) : src(0),
      cash:             ca  != null ? src(ca)  : src(0),
      totalAssets:      ta  != null ? src(ta)  : unavailable(),
      totalLiabilities: tl  != null ? src(tl)  : unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
    }
  }).filter(r => r.year && r.totalAssets.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // Cash flow
  const cfStmt = qs.cashflowStatementHistory?.cashflowStatements || []
  const cashflowHistory = cfStmt.map(s => {
    const opCF  = rv(s.totalCashFromOperatingActivities)
    const invCF = rv(s.totalCashflowsFromInvestingActivities)
    const finCF = rv(s.totalCashFromFinancingActivities)
    const capex = rv(s.capitalExpenditures)
    const fcf   = rv(s.freeCashFlow)
    const fcfDerived = opCF != null && capex != null ? opCF - Math.abs(capex) : null

    return {
      year:         yearOf(rv(s.endDate)),
      operatingCF:  opCF  != null ? src(opCF)  : unavailable(),
      investingCF:  invCF != null ? src(invCF) : unavailable(),
      financingCF:  finCF != null ? src(finCF) : unavailable(),
      freeCashFlow: fcf   != null ? src(fcf)
                  : fcfDerived != null ? derived(fcfDerived, 'Operating CF − |CapEx|')
                  : unavailable(),
    }
  }).filter(r => r.year && r.operatingCF.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // TTM from financialData
  const ttmData = {
    revenue:          rv(fin.totalRevenue)      != null ? src(rv(fin.totalRevenue))      : unavailable(),
    grossProfit:      rv(fin.grossProfits)      != null ? src(rv(fin.grossProfits))      : unavailable(),
    ebitda:           rv(fin.ebitda)            != null ? src(rv(fin.ebitda))            : unavailable(),
    netProfit:        rv(fin.netIncomeToCommon) != null ? src(rv(fin.netIncomeToCommon)) : unavailable(),
    eps:              (rv(fin.trailingEps) ?? rv(ks.trailingEps)) != null
                        ? src(rv(fin.trailingEps) ?? rv(ks.trailingEps)) : unavailable(),
    operatingCF:      rv(fin.operatingCashflow) != null ? src(rv(fin.operatingCashflow)) : unavailable(),
    freeCashFlow:     rv(fin.freeCashflow)       != null ? src(rv(fin.freeCashflow))      : unavailable(),
    totalDebt:        rv(fin.totalDebt)          != null ? src(rv(fin.totalDebt))         : unavailable(),
    cash:             rv(fin.totalCash)          != null ? src(rv(fin.totalCash))         : unavailable(),
    grossMargins:     rv(fin.grossMargins)       != null ? ttm(rv(fin.grossMargins))      : unavailable(),
    profitMargins:    rv(fin.profitMargins)      != null ? ttm(rv(fin.profitMargins))     : unavailable(),
    ebitdaMargins:    rv(fin.ebitdaMargins)      != null ? ttm(rv(fin.ebitdaMargins))     : unavailable(),
    operatingMargins: rv(fin.operatingMargins)   != null ? ttm(rv(fin.operatingMargins))  : unavailable(),
    roe:              rv(fin.returnOnEquity)      != null ? ttm(rv(fin.returnOnEquity))    : unavailable(),
    debtToEquity:     rv(fin.debtToEquity)       != null ? ttm(rv(fin.debtToEquity))      : unavailable(),
    currentRatio:     rv(fin.currentRatio)       != null ? ttm(rv(fin.currentRatio))      : unavailable(),
    revenueGrowth:    rv(fin.revenueGrowth)      != null ? ttm(rv(fin.revenueGrowth))     : unavailable(),
    earningsGrowth:   rv(fin.earningsGrowth)     != null ? ttm(rv(fin.earningsGrowth))    : unavailable(),
  }

  // ── Synthesize from TTM when statement history is sparse ──────────────────
  // Yahoo often returns limited statement history for Indian stocks.
  // Fall back to TTM financialData fields to ensure valuation models have data.
  const ttmRevenue = rv(fin.totalRevenue)
  const ttmEbitda  = rv(fin.ebitda)
  const ttmNP      = rv(fin.netIncomeToCommon)
  const ttmEps     = rv(fin.trailingEps) ?? rv(ks.trailingEps)
  const ttmOpCF    = rv(fin.operatingCashflow)
  const ttmFCF     = rv(fin.freeCashflow)
  const ttmDebt    = rv(fin.totalDebt)
  const ttmCash    = rv(fin.totalCash)
  const ttmROE     = rv(fin.returnOnEquity)  // fraction e.g. 0.106
  const ttmDE      = rv(fin.debtToEquity)    // e.g. 33.5 (= D/E as %)
  const ttmOpM     = rv(fin.operatingMargins)

  if (incomeHistory.length === 0 && (ttmRevenue || ttmNP)) {
    const yr = new Date().getFullYear().toString()
    incomeHistory.push({
      year:            yr,
      revenue:         ttmRevenue != null ? src(ttmRevenue)                         : unavailable(),
      expenses:        unavailable(),
      grossProfit:     rv(fin.grossProfits) != null ? src(rv(fin.grossProfits))     : unavailable(),
      operatingProfit: ttmRevenue && ttmOpM ? derived(ttmRevenue * ttmOpM, 'Revenue × Operating Margin (TTM)') : unavailable(),
      ebitda:          ttmEbitda  != null ? src(ttmEbitda)                          : unavailable(),
      depreciation:    unavailable(),
      interest:        unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ttmNP      != null ? src(ttmNP)                              : unavailable(),
      eps:             ttmEps     != null ? src(ttmEps)                             : unavailable(),
    })
  }

  if (balanceHistory.length === 0 && (ttmDebt != null || ttmDE != null)) {
    // Derive totalEquity from D/E ratio: equity = debt / (D/E)
    // Yahoo D/E for Indian stocks is typically given as percentage e.g. 33.5 means 33.5%
    // Sanity check: if D/E > 10, it's likely a % not a ratio
    const deRatio    = ttmDE != null ? (ttmDE > 10 ? ttmDE / 100 : ttmDE) : null
    const equityFromDE  = ttmDebt && deRatio ? ttmDebt / deRatio : null
    // Alternatively derive from ROE: equity = netProfit / ROE
    const equityFromROE = ttmNP && ttmROE && ttmROE > 0 ? ttmNP / ttmROE : null
    const equity = equityFromDE ?? equityFromROE

    const yr = new Date().getFullYear().toString()
    balanceHistory.push({
      year:            yr,
      equityCapital:   unavailable(),
      reserves:        unavailable(),
      totalEquity:     equity != null ? derived(equity, deRatio ? 'Total Debt ÷ D/E Ratio (TTM)' : 'Net Profit ÷ ROE (TTM)') : unavailable(),
      totalDebt:       ttmDebt != null ? src(ttmDebt)   : unavailable(),
      totalAssets:     unavailable(),
      totalLiabilities: unavailable(),
      fixedAssets:     unavailable(),
      investments:     unavailable(),
      cash:            ttmCash != null ? src(ttmCash)   : unavailable(),
    })
  }

  if (cashflowHistory.length === 0 && (ttmOpCF || ttmFCF)) {
    const yr = new Date().getFullYear().toString()
    const fcfDerived = ttmOpCF && !ttmFCF ? derived(ttmOpCF * 0.7, 'Operating CF × 0.7 (proxy)') : null
    cashflowHistory.push({
      year:         yr,
      operatingCF:  ttmOpCF != null ? src(ttmOpCF)         : unavailable(),
      investingCF:  unavailable(),
      financingCF:  unavailable(),
      freeCashFlow: ttmFCF  != null ? src(ttmFCF) : fcfDerived ?? unavailable(),
    })
  }

  return {
    ticker,
    name:     q7.longName || q7.shortName || chartMeta.instrumentType || ticker,
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
      exchange:  q7.exchange  || chartMeta.exchangeName || null,
      pe:        q7.trailingPE ?? rv(sd.trailingPE),
      pb:        q7.priceToBook ?? rv(ks.priceToBook),
      divYield:  q7.trailingAnnualDividendYield ?? rv(sd.dividendYield),
      beta:      q7.beta      ?? rv(sd.beta),
      high52:    q7.fiftyTwoWeekHigh  ?? rv(sd.fiftyTwoWeekHigh),
      low52:     q7.fiftyTwoWeekLow   ?? rv(sd.fiftyTwoWeekLow),
      avgVolume: q7.averageDailyVolume3Month ?? rv(sd.averageVolume),
      change1d:  q7.regularMarketChangePercent ?? null,
      volume:    q7.regularMarketVolume ?? null,
    },
    sourceStats: {}
  }
}

// ─── Screener normalizer ──────────────────────────────────────────────────────

function normalizeScreener(raw) {
  // Screener values are in Crores — scale to absolute INR (× 1e7)
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
    eps:             r.eps ?? unavailable(),  // EPS is per-share, not in Crores
    grossProfit:     unavailable(),  // not a separate line in Indian P&L
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
    cash:             unavailable(),  // Screener doesn't separate cash in balance sheet
  }))

  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  scaleCr(r.operatingCF),
    investingCF:  scaleCr(r.investingCF),
    financingCF:  scaleCr(r.financingCF),
    freeCashFlow: scaleCr(r.freeCashFlow),
  }))

  // Price & market cap from key stats (reference)
  const ks       = raw.keyStats || {}
  const price    = ks['currentprice']?.value  ?? ks['price']?.value ?? null
  const mcapCr   = ks['marketcap']?.value     ?? null
  const marketCap = mcapCr != null ? mcapCr * CR : null

  // Build minimal TTM from most recent income row
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
      pe:      ks['stockpe']?.value   ?? null,
      pb:      null,
      divYield: ks['dividendyield']?.value ?? null,
    },
    keyStats: raw.keyStats,
    sourceStats: raw.keyStats || {},
    parserStatus: raw.parserStatus
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rv(v) {
  if (v == null) return null
  if (typeof v === 'object' && 'raw' in v) return v.raw
  if (typeof v === 'number') return v
  return null
}

function yearOf(unix) {
  return unix ? new Date(unix * 1000).getFullYear().toString() : null
}
