/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * ALL values stored with resolution metadata: { value, status, formula }
 * status: 'source' | 'derived' | 'positional' | 'cross-source' | 'ttm' | 'unavailable'
 *
 * Priority Hierarchical Order: CSV > Screener > Yahoo Finance
 */

export function normalize(source, raw) {
  if (source === 'csv')      return raw // CSV has the absolute highest priority and bypasses mergers
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  throw new Error(`Unknown source: ${source}`)
}

const CR = 1e7  // Crore to absolute INR multiplier

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

/**
 * Merges datasets prioritizing Screener data as the structural baseline,
 * falling back to Yahoo metrics only if Screener values are missing or unavailable.
 */
export function normalizeMerged({ yahoo, screener }) {
  const s = normalizeScreener(screener || {})
  const y = normalizeYahoo(yahoo || {})

  // Merge historical statements using Screener as primary and Yahoo as fallback
  const income   = mergeByYear(s.incomeHistory,   y.incomeHistory,   mergeIncomeRow)
  const balance  = mergeByYear(s.balanceHistory,  y.balanceHistory,  mergeBalanceRow)
  const cashflow = mergeByYear(s.cashflowHistory, y.cashflowHistory, mergeCFRow)

  return {
    ...s, // Anchor base properties to Screener
    ticker: s.ticker || y.ticker,
    name: s.name || y.name,
    currency: s.currency || y.currency || 'INR',
    source: 'merged',
    price:     s.price     ?? y.price,
    marketCap: s.marketCap ?? y.marketCap,
    shares:    s.shares    ?? y.shares,
    incomeHistory:  income,
    balanceHistory: balance,
    cashflowHistory: cashflow,
    ttm: mergeTTM(s.ttm, y.ttm),
    meta: { ...(y.meta || {}), ...(s.meta || {}) },
    sourceStats: s.keyStats || y.sourceStats || {}
  }
}

function mergeByYear(primaryArr, fallbackArr, mergeFn) {
  const map = {}
  for (const r of (fallbackArr || [])) {
    if (r.year) map[r.year] = r
  }
  for (const r of (primaryArr || [])) {
    if (!r.year) continue
    map[r.year] = map[r.year] ? mergeFn(r, map[r.year]) : r
  }
  return Object.values(map).sort((a, b) => String(a.year).localeCompare(String(b.year)))
}

function mergeIncomeRow(primary, fallback) {
  const pick = (pField, fField, name) => {
    if (pField?.value != null && pField.status !== 'unavailable') return pField
    if (fField?.value != null && fField.status !== 'unavailable') {
      return { ...fField, status: 'cross-source', formula: `From Yahoo (Screener missing ${name})` }
    }
    return unavailable()
  }
  return {
    year: primary.year || fallback.year,
    revenue:         pick(primary.revenue,         fallback.revenue,         'revenue'),
    expenses:        pick(primary.expenses,        fallback.expenses,        'expenses'),
    operatingProfit: pick(primary.operatingProfit, fallback.operatingProfit, 'operatingProfit'),
    ebitda:          pick(primary.ebitda,          fallback.ebitda,          'ebitda'),
    depreciation:    pick(primary.depreciation,    fallback.depreciation,    'depreciation'),
    interest:        pick(primary.interest,        fallback.interest,        'interest'),
    otherIncome:     pick(primary.otherIncome,     fallback.otherIncome,     'otherIncome'),
    netProfit:       pick(primary.netProfit,       fallback.netProfit,       'netProfit'),
    eps:             pick(primary.eps,             fallback.eps,             'eps'),
  }
}

function mergeBalanceRow(primary, fallback) {
  const pick = (pField, fField, name) => {
    if (pField?.value != null && pField.status !== 'unavailable') return pField
    if (fField?.value != null && fField.status !== 'unavailable') {
      return { ...fField, status: 'cross-source', formula: `From Yahoo (Screener missing ${name})` }
    }
    return unavailable()
  }
  return {
    year: primary.year || fallback.year,
    equityCapital:   pick(primary.equityCapital,    fallback.equityCapital,    'equityCapital'),
    reserves:        pick(primary.reserves,         fallback.reserves,         'reserves'),
    totalEquity:     pick(primary.totalEquity,      fallback.totalEquity,      'totalEquity'),
    totalDebt:       pick(primary.totalDebt,        fallback.totalDebt,        'totalDebt'),
    totalAssets:     pick(primary.totalAssets,      fallback.totalAssets,      'totalAssets'),
    totalLiabilities:pick(primary.totalLiabilities, fallback.totalLiabilities, 'totalLiabilities'),
    fixedAssets:     pick(primary.fixedAssets,      fallback.fixedAssets,      'fixedAssets'),
    investments:     pick(primary.investments,      fallback.investments,      'investments'),
    cash:            pick(primary.cash,             fallback.cash,             'cash'),
  }
}

function mergeCFRow(primary, fallback) {
  const pick = (pField, fField, name) => {
    if (pField?.value != null && pField.status !== 'unavailable') return pField
    if (fField?.value != null && fField.status !== 'unavailable') {
      return { ...fField, status: 'cross-source', formula: `From Yahoo (Screener missing ${name})` }
    }
    return unavailable()
  }
  return {
    year: primary.year || fallback.year,
    operatingCF:  pick(primary.operatingCF,  fallback.operatingCF,  'operatingCF'),
    investingCF:  pick(primary.investingCF,  fallback.investingCF,  'investingCF'),
    financingCF:  pick(primary.financingCF,  fallback.financingCF,  'financingCF'),
    freeCashFlow: pick(primary.freeCashFlow, fallback.freeCashFlow, 'freeCashFlow'),
  }
}

function mergeTTM(primary, fallback) {
  if (!primary) return fallback || {}; if (!fallback) return primary || {}
  const out = { ...primary }
  for (const k of Object.keys(fallback ?? {})) {
    if ((out[k]?.value == null || out[k]?.status === 'unavailable') && fallback[k]?.value != null) {
      out[k] = { ...fallback[k], status: 'cross-source', formula: 'TTM from Yahoo fallback' }
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
  
  const CR = 1e7; // Multiplier to scale Crores to absolute INR

  // Helper that safely preserves the server-side resolution status while multiplying by Crore
  const adaptAndScaleCr = (fieldObj) => {
    if (!fieldObj || fieldObj.value == null || fieldObj.status === 'unavailable') {
      return { value: null, status: 'unavailable', formula: null };
    }
    return {
      value: Number(fieldObj.value) * CR,
      status: fieldObj.status || 'source',
      formula: fieldObj.formula || null
    };
  };

  // 1. Map Income History
  const inc = (raw.incomeHistory || []).map(r => ({
    year:            r.year,
    revenue:         adaptAndScaleCr(r.revenue),
    expenses:        adaptAndScaleCr(r.expenses),
    operatingProfit: adaptAndScaleCr(r.operatingProfit),
    ebitda:          adaptAndScaleCr(r.ebitda),
    depreciation:    adaptAndScaleCr(r.depreciation),
    interest:        adaptAndScaleCr(r.interest),
    otherIncome:     adaptAndScaleCr(r.otherIncome),
    profitBeforeTax: adaptAndScaleCr(r.profitBeforeTax),
    netProfit:       adaptAndScaleCr(r.netProfit),
    eps:             r.eps && r.eps.value != null ? { ...r.eps } : { value: null, status: 'unavailable', formula: null } // EPS is not multiplied by Crore
  }));

  // 2. Map Balance History
  const bal = (raw.balanceHistory || []).map(r => ({
    year:             r.year,
    equityCapital:    adaptAndScaleCr(r.equityCapital),
    reserves:         adaptAndScaleCr(r.reserves),
    totalEquity:      adaptAndScaleCr(r.totalEquity),
    totalDebt:        adaptAndScaleCr(r.totalDebt),
    totalAssets:      adaptAndScaleCr(r.totalAssets),
    totalLiabilities: adaptAndScaleCr(r.totalLiabilities),
    fixedAssets:      adaptAndScaleCr(r.fixedAssets),
    investments:      adaptAndScaleCr(r.investments),
  }));

  // 3. Map Cash Flow History
  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  adaptAndScaleCr(r.operatingCF),
    investingCF:  adaptAndScaleCr(r.investingCF),
    financingCF:  adaptAndScaleCr(r.financingCF),
    freeCashFlow: adaptAndScaleCr(r.freeCashFlow),
  }));

  // 4. Handle Key Live Stats (Market Cap & Current Price)
  const ks = raw.keyStats || {};
  
  // Safely find pricing keys from your keyStats parser
  const rawPrice = ks['currentprice']?.value ?? ks['stockprice']?.value ?? null;
  const rawMcap  = ks['marketcap']?.value ?? null;

  const price     = rawPrice != null ? Number(rawPrice) : null;
  const marketCap = rawMcap != null ? Number(rawMcap) * CR : null;

  // Extract the latest year's records to formulate the baseline TTM object
  const latestInc = inc[inc.length - 1] || {};
  const latestBal = bal[bal.length - 1] || {};
  const latestCF  = cf[cf.length - 1]  || {};

  return {
    ticker: raw.ticker || '',
    name: raw.name || raw.ticker || '',
    source: 'screener',
    currency: 'INR',
    price,
    marketCap,
    shares: marketCap && price ? (marketCap / price) : null,
    priceHistory: [],
    incomeHistory: inc,
    balanceHistory: bal,
    cashflowHistory: cf,
    ttm: {
      revenue:       latestInc.revenue         || { value: null, status: 'unavailable', formula: null },
      netProfit:     latestInc.netProfit       || { value: null, status: 'unavailable', formula: null },
      ebitda:        latestInc.ebitda          || { value: null, status: 'unavailable', formula: null },
      operatingCF:   latestCF.operatingCF      || { value: null, status: 'unavailable', formula: null },
      freeCashFlow:  latestCF.freeCashFlow     || { value: null, status: 'unavailable', formula: null },
      totalDebt:     latestBal.totalDebt       || { value: null, status: 'unavailable', formula: null },
      cash:          latestBal.cash            || { value: null, status: 'unavailable', formula: null },
      grossMargins:  { value: null, status: 'unavailable', formula: null },
      profitMargins: { value: null, status: 'unavailable', formula: null },
      ebitdaMargins: { value: null, status: 'unavailable', formula: null }
    },
    meta: {
      sector: null,
      industry: null,
      exchange: 'NSE/BSE',
      pe:       ks['stockpe']?.value       ?? null,
      pb:       ks['pricetobook']?.value   ?? null,
      divYield: ks['dividendyield']?.value ?? null,
    },
    sourceStats: ks,
    parserStatus: raw.parserStatus || { degraded: false, missingCore: [] }
  };
}

function rv(v) { return v != null && typeof v === 'object' && 'raw' in v ? v.raw : (typeof v === 'number' ? v : null) }
function yearOf(unix) { return unix ? new Date(unix * 1000).getFullYear().toString() : null }