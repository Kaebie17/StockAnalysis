/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * ALL values stored with resolution metadata: { value, status, formula }
 * status: 'source' | 'derived' | 'positional' | 'cross-source' | 'ttm' | 'unavailable'
 */

export function normalize(source, raw) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  if (source === 'csv')      return raw
  throw new Error(`Unknown source: ${source}`)
}

const CR = 1e7  // Crore to absolute INR

function src(value)                      { return { value: value != null ? Number(value) : null, status: 'source',       formula: null } }
function derived(value, formula)         { return { value: value != null ? Number(value) : null, status: 'derived',      formula } }
function crossSrc(value, srcName)        { return { value: value != null ? Number(value) : null, status: 'cross-source', formula: srcName } }
function ttm(value)                      { return { value: value != null ? Number(value) : null, status: 'ttm',          formula: 'TTM from financialData' } }
function unavailable()                   { return { value: null, status: 'unavailable', formula: null } }

function scaleCr(tagged) {
  if (!tagged) return unavailable()
  const numericalVal = tagged.value != null ? tagged.value : (typeof tagged === 'number' ? tagged : null)
  if (numericalVal == null) return unavailable()
  return { value: numericalVal * CR, status: tagged.status || 'source', formula: tagged.formula || null }
}

export function normalizeMerged({ yahoo, screener }) {
  const y = normalizeYahoo(yahoo || {})
  const s = normalizeScreener(screener || {})

  const income   = mergeByYear(y.incomeHistory,   s.incomeHistory,   mergeIncomeRow)
  const balance  = mergeByYear(y.balanceHistory,  s.balanceHistory,  mergeBalanceRow)
  const cashflow = mergeByYear(y.cashflowHistory, s.cashflowHistory, mergeCFRow)

  return {
    ...y,
    ticker: y.ticker || s.ticker,
    name: y.name || s.name,
    currency: y.currency || s.currency || 'INR',
    source: 'merged',
    price:     y.price     ?? s.price,
    marketCap: y.marketCap ?? s.marketCap,
    shares:    y.shares    ?? s.shares,
    incomeHistory:  income,
    balanceHistory: balance,
    cashflowHistory: cashflow,
    ttm: mergeTTM(y.ttm, s.ttm),
    meta: { ...(s.meta || {}), ...(y.meta || {}) },
    sourceStats: s.keyStats || {}
  }
}

function mergeByYear(yArr, sArr, mergeFn) {
  const map = {}
  for (const r of (sArr || [])) if (r.year) map[r.year] = r
  for (const r of (yArr || [])) {
    if (!r.year) continue
    map[r.year] = map[r.year] ? mergeFn(r, map[r.year]) : r
  }
  return Object.values(map).sort((a, b) => String(a.year).localeCompare(String(b.year)))
}

function mergeIncomeRow(y, s) {
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year || s.year,
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
    year: y.year || s.year,
    equityCapital:   pick(y.equityCapital,    s.equityCapital,    'equityCapital'),
    reserves:        pick(y.reserves,         s.reserves,         'reserves'),
    totalEquity:     pick(y.totalEquity,      s.totalEquity,      'totalEquity'),
    totalDebt:       pick(y.totalDebt,        s.totalDebt,        'totalDebt'),
    totalAssets:     pick(y.totalAssets,      s.totalAssets,      'totalAssets'),
    totalLiabilities:pick(y.totalLiabilities, s.totalLiabilities, 'totalLiabilities'),
    fixedAssets:     pick(y.fixedAssets,      s.fixedAssets,      'fixedAssets'),
    investments:     pick(y.investments,      s.investments,      'investments'),
    cash:            pick(y.cash,             s.cash,             'cash'),
  }
}

function mergeCFRow(y, s) {
  const pick = (yf, sf, name) => {
    if (yf?.value != null) return yf
    if (sf?.value != null) return { ...sf, status: 'cross-source', formula: `From Screener (Yahoo missing ${name})` }
    return unavailable()
  }
  return {
    year: y.year || s.year,
    operatingCF:  pick(y.operatingCF,  s.operatingCF,  'operatingCF'),
    investingCF:  pick(y.investingCF,  s.investingCF,  'investingCF'),
    financingCF:  pick(y.financingCF,  s.financingCF,  'financingCF'),
    freeCashFlow: pick(y.freeCashFlow, s.freeCashFlow, 'freeCashFlow'),
  }
}

function mergeTTM(y, s) {
  if (!y) return s || {}; if (!s) return y || {}
  const out = { ...y }
  for (const k of Object.keys(s ?? {})) {
    if (out[k]?.value == null && s[k]?.value != null) {
      out[k] = s[k]
    }
  }
  return out
}

export function normalizeYahoo(raw) {
  if (!raw) return { ttm: {}, incomeHistory: [], balanceHistory: [], cashflowHistory: [] }
  const { ticker, chart, quote, fundamentals } = raw
  const q7  = quote?.quoteResponse?.result?.[0]      || {}
  const qs  = fundamentals?.quoteSummary?.result?.[0] || {}
  const fin = qs.financialData      || {}
  const ks  = qs.defaultKeyStatistics || {}
  const sd  = qs.summaryDetail      || {}
  const ap  = qs.assetProfile       || {}
  const chartMeta = chart?.chart?.result?.[0]?.meta || {}

  const currency = chartMeta.currency || q7.currency || 'USD'
  const price     = q7.regularMarketPrice ?? chartMeta.regularMarketPrice ?? rv(fin.currentPrice)
  const marketCap = q7.marketCap          ?? rv(ks.marketCap)
  const shares    = q7.sharesOutstanding  ?? rv(ks.sharesOutstanding)

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
      expenses:        unavailable(),
      grossProfit:     gp   != null ? src(gp)   : unavailable(),
      operatingProfit: opI  != null ? src(opI)  : unavailable(),
      ebitda:          unavailable(),
      depreciation:    unavailable(),
      interest:        int  != null ? src(int)  : unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ni   != null ? src(ni)   : unavailable(),
      eps:             unavailable(),
    }
  }).filter(r => r.year && r.revenue.value != null)

  for (const e of (qs.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => String(r.year) === String(e.date))
    if (row && e.earnings != null) row.eps = src(rv(e.earnings))
  }

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

  const ttmData = {
    revenue:          rv(fin.totalRevenue)      != null ? src(rv(fin.totalRevenue))      : unavailable(),
    grossProfit:      rv(fin.grossProfits)      != null ? src(rv(fin.grossProfits))      : unavailable(),
    ebitda:           rv(fin.ebitda)            != null ? src(rv(fin.ebitda))            : unavailable(),
    netProfit:        rv(fin.netIncomeToCommon) != null ? src(rv(fin.netIncomeToCommon)) : unavailable(),
    eps:              rv(fin.trailingEps) ?? rv(ks.trailingEps) != null ? src(rv(fin.trailingEps) ?? rv(ks.trailingEps)) : unavailable(),
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

  return {
    ticker, name: q7.longName || q7.shortName || ticker, source: 'yahoo', currency, price, marketCap, shares,
    priceHistory: [], incomeHistory, balanceHistory, cashflowHistory, ttm: ttmData,
    meta: {
      sector: ap.sector || null, industry: ap.industry || null, exchange: q7.exchange || null,
      pe: q7.trailingPE ?? rv(sd.trailingPE), pb: q7.priceToBook ?? rv(ks.priceToBook), divYield: q7.trailingAnnualDividendYield ?? rv(sd.dividendYield),
    }
  }
}

export function normalizeScreener(raw) {
  if (!raw) return { ttm: {}, incomeHistory: [], balanceHistory: [], cashflowHistory: [] }
  
  const wrapScreenerField = (f) => {
    if (f && typeof f === 'object' && 'value' in f) return src(f.value)
    if (typeof f === 'number') return src(f)
    return unavailable()
  }

  const inc = (raw.incomeHistory  || []).map(r => ({
    year:            r.year,
    revenue:         scaleCr(wrapScreenerField(r.revenue)),
    expenses:        scaleCr(wrapScreenerField(r.expenses)),
    operatingProfit: scaleCr(wrapScreenerField(r.operatingProfit)),
    ebitda:          scaleCr(wrapScreenerField(r.ebitda)),
    depreciation:    scaleCr(wrapScreenerField(r.depreciation)),
    interest:        scaleCr(wrapScreenerField(r.interest)),
    otherIncome:     scaleCr(wrapScreenerField(r.otherIncome)),
    netProfit:       scaleCr(wrapScreenerField(r.netProfit)),
    eps:             r.eps != null ? wrapScreenerField(r.eps) : unavailable(),
  }))

  const bal = (raw.balanceHistory || []).map(r => ({
    year:             r.year,
    totalEquity:      scaleCr(wrapScreenerField(r.totalEquity)),
    totalDebt:        scaleCr(wrapScreenerField(r.totalDebt)),
    totalAssets:      scaleCr(wrapScreenerField(r.totalAssets)),
    cash:             scaleCr(wrapScreenerField(r.cash)),
  }))

  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  scaleCr(wrapScreenerField(r.operatingCF)),
    freeCashFlow: scaleCr(wrapScreenerField(r.freeCashFlow)),
  }))

  const ks       = raw.keyStats || {}
  const price    = ks['currentprice']?.value  ?? ks['price']?.value
  const mcapCr   = ks['marketcap']?.value
  const marketCap = mcapCr != null ? mcapCr * CR : null

  const latestInc = inc[inc.length - 1] || {}
  const latestBal = bal[bal.length - 1] || {}
  const latestCF  = cf[cf.length - 1]  || {}

  return {
    ticker: raw.ticker, name: raw.name || raw.ticker, source: 'screener', currency: 'INR', price, marketCap, shares: null,
    incomeHistory: inc, balanceHistory: bal, cashflowHistory: cf,
    ttm: {
      revenue: latestInc.revenue || unavailable(), netProfit: latestInc.netProfit || unavailable(), ebitda: latestInc.ebitda || unavailable(),
      operatingCF: latestCF.operatingCF || unavailable(), freeCashFlow: latestCF.freeCashFlow || unavailable(),
      totalDebt: latestBal.totalDebt || unavailable(), cash: latestBal.cash || unavailable(),
    },
    meta: { pe: ks['stockpe']?.value, pb: ks['pricetobook']?.value, divYield: ks['dividendyield']?.value }
  }
}

function rv(v) { return v != null && typeof v === 'object' && 'raw' in v ? v.raw : (typeof v === 'number' ? v : null) }
function yearOf(unix) { return unix ? new Date(unix * 1000).getFullYear().toString() : null }