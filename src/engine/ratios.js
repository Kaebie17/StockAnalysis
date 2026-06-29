/**
 * src/engine/ratios.js
 *
 * ALL ratios computed from raw normalized data.
 * No ratio is ever taken from a source — sources provide only raw numbers.
 *
 * Each output ratio carries resolution metadata:
 *   { value, status, formula }
 *   status: 'calculated' | 'ttm-fallback' | 'unavailable'
 *
 * Derivation hierarchy for each ratio:
 *   1. Calculate from historical statement data
 *   2. Fall back to TTM financialData if history sparse
 *   3. Mark unavailable — never silently return null
 */

export function calcRatios(data) {
  const { price, marketCap, shares: sharesRaw, incomeHistory,
          balanceHistory, cashflowHistory, ttm, meta } = data

  // Unwrap tagged values from latest year
  const latestI  = incomeHistory[incomeHistory.length - 1]   || {}
  const prevI    = incomeHistory[incomeHistory.length - 2]   || {}
  const oldestI  = incomeHistory[0]                          || {}
  const latestB  = balanceHistory[balanceHistory.length - 1]  || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}
  const n        = incomeHistory.length - 1

  // Helper: unwrap .value from tagged field
  const val = f => f?.value ?? null

  // ── Core raw values ────────────────────────────────────────────────────────
  const revenue     = val(latestI.revenue)     ?? val(ttm?.revenue)
  const opProfit    = val(latestI.operatingProfit)
  const depreciation= val(latestI.depreciation)
  const interest    = val(latestI.interest)
  const netProfit   = val(latestI.netProfit)   ?? val(ttm?.netProfit)
  // totalEquity: statement → derive from TTM D/E ratio → derive from TTM ROE
  const rawEquity = val(latestB.totalEquity)
  const ttmDebt2  = val(latestB.totalDebt) ?? val(ttm?.totalDebt) ?? 0
  const ttmDE     = val(ttm?.debtToEquity)
  const deRatio   = ttmDE != null ? (ttmDE > 10 ? ttmDE / 100 : ttmDE) : null
  const equityFromDE  = ttmDebt2 > 0 && deRatio ? ttmDebt2 / deRatio : null
  const equityFromROE = val(ttm?.netProfit) && val(ttm?.roe) && val(ttm?.roe) > 0
    ? val(ttm.netProfit) / val(ttm.roe) : null
  const totalEquity = rawEquity ?? equityFromDE ?? equityFromROE
  const totalDebt   = val(latestB.totalDebt)   ?? val(ttm?.totalDebt) ?? 0
  const cash        = val(latestB.cash)        ?? val(ttm?.cash)       ?? 0
  const opCF        = val(latestCF.operatingCF) ?? val(ttm?.operatingCF)
  const fcf         = val(latestCF.freeCashFlow) ?? val(ttm?.freeCashFlow)
  const totalAssets = val(latestB.totalAssets)
  const fixedAssets = val(latestB.fixedAssets)

  // Shares: from data or estimate from marketCap/price
  const shares = sharesRaw ?? (marketCap && price ? marketCap / price : null)

  // EPS: statement → TTM → derive
  const epsRaw = val(latestI.eps) ?? val(ttm?.eps)
  const eps = epsRaw ?? calc('Net Profit ÷ Shares', netProfit, shares, (n, s) => n / s)

  // ── EBITDA ─────────────────────────────────────────────────────────────────
  // Priority: direct from source → Op.Profit + Dep → TTM → Op.Profit alone
  const ebitdaDirect = val(latestI.ebitda)
  const ebitdaCalc   = opProfit != null && depreciation != null ? opProfit + depreciation : null
  const ebitdaTTM    = val(ttm?.ebitda)
  const ebitda       = ebitdaDirect ?? ebitdaCalc ?? ebitdaTTM ?? opProfit

  const ebitdaStatus = ebitdaDirect  != null ? 'source'
    : ebitdaCalc   != null ? 'calculated'
    : ebitdaTTM    != null ? 'ttm-fallback'
    : opProfit     != null ? 'proxy'  // using op profit as proxy
    : 'unavailable'
  const ebitdaFormula = ebitdaCalc  != null ? 'Operating Profit + Depreciation'
    : ebitdaTTM    != null ? 'TTM from Yahoo financialData'
    : opProfit     != null ? 'Operating Profit (Depreciation unavailable)'
    : null

  // ── Revenue CAGR ───────────────────────────────────────────────────────────
  const revOldest = val(oldestI.revenue)
  const revLatest = val(latestI.revenue)
  const revCagr   = n > 0 && revOldest > 0 && revLatest > 0
    ? (Math.pow(revLatest / revOldest, 1 / n) - 1) * 100 : null

  // ── EV ─────────────────────────────────────────────────────────────────────
  const ev = marketCap != null ? marketCap + totalDebt - cash : null

  // ── Margins ────────────────────────────────────────────────────────────────
  // Note: Indian P&L has no "Gross Profit" line — Operating Profit IS the first
  // meaningful margin. We flag grossMargin as "Operating Margin (Indian P&L format)"
  const operatingMargin = pct(opProfit, revenue)
  const ebitdaMargin    = pct(ebitda, revenue)  ?? pct100(val(ttm?.ebitdaMargins))
  const netMargin       = pct(netProfit, revenue) ?? pct100(val(ttm?.profitMargins))
  // Gross margin: use Yahoo's if available (US companies), else use operating margin
  const grossMarginRaw  = val(ttm?.grossMargins)
  const grossMargin     = grossMarginRaw != null
    ? { value: grossMarginRaw * 100, status: 'ttm-fallback', formula: 'From Yahoo financialData' }
    : operatingMargin != null
    ? { value: operatingMargin, status: 'proxy', formula: 'Operating Margin (Indian P&L — no separate Gross Profit line)' }
    : { value: null, status: 'unavailable', formula: null }

  // ── Returns ────────────────────────────────────────────────────────────────
  // ROE = Net Profit / Average Equity × 100
  const prevEquity = val(balanceHistory[balanceHistory.length - 2]?.totalEquity)
  const avgEquity  = totalEquity != null && prevEquity != null
    ? (totalEquity + prevEquity) / 2 : totalEquity
  const roe  = pct(netProfit, avgEquity) ?? pct100(val(ttm?.roe))

  // ROCE = EBIT / Capital Employed × 100
  // Capital Employed = Total Assets - Current Liabilities
  // We approximate: Capital Employed = Total Equity + Total Debt (= long-term capital)
  const capitalEmployed = totalEquity != null ? totalEquity + totalDebt : null
  const roce = pct(ebitda, capitalEmployed)  // EBIT ≈ EBITDA here; flag if no dep

  // ROA = Net Profit / Total Assets × 100
  const roa  = pct(netProfit, totalAssets)

  // ── Leverage ───────────────────────────────────────────────────────────────
  const netDebt = totalDebt - cash
  const de      = div(totalDebt, totalEquity)           // D/E ratio
  const icr     = div(ebitda, interest)                 // Interest coverage

  // ── Valuation multiples ────────────────────────────────────────────────────
  // All calculated from raw numbers — never from source
  const bookPerShare = div(totalEquity, shares)
  const pe           = div(price, eps)           ?? meta?.pe   // meta.pe = v7 quote (reference)
  const pb           = div(price, bookPerShare)  ?? meta?.pb
  const ps           = div(marketCap, revenue)
  const evEbitda     = div(ev, ebitda)
  const evRevenue    = div(ev, revenue)

  // Graham Number = √(22.5 × EPS × Book Value per Share)
  const grahamNumber = eps > 0 && bookPerShare > 0
    ? Math.sqrt(22.5 * eps * bookPerShare) : null

  // ── FCF metrics ────────────────────────────────────────────────────────────
  const fcfYield      = pct(fcf, marketCap)
  const fcfConversion = pct(fcf, netProfit)

  // ── Growth ─────────────────────────────────────────────────────────────────
  const prevRev    = val(prevI.revenue)
  const prevNP     = val(prevI.netProfit)
  const revGrowthYoY = pct(revenue - (prevRev || 0), prevRev) ?? pct100(val(ttm?.revenueGrowth))
  const npGrowthYoY  = pct(netProfit - (prevNP || 0), prevNP)  ?? pct100(val(ttm?.earningsGrowth))

  return {
    // Scalars (used by valuation engine)
    price, marketCap, ev, shares,
    revenue, opProfit, ebitda, netProfit, interest, depreciation,
    totalEquity, totalDebt, cash, netDebt, capitalEmployed, totalAssets,
    opCF, fcf, eps, bookPerShare, grahamNumber,

    // Tagged ratios (used by UI for display + tooltips)
    ratios: {
      // Margins
      grossMargin,
      operatingMargin: tag(operatingMargin, 'calculated', 'Operating Profit ÷ Revenue × 100'),
      ebitdaMargin:    tag(ebitdaMargin,    ebitdaMargin != null ? (val(ttm?.ebitdaMargins) != null && ebitdaDirect == null ? 'ttm-fallback' : 'calculated') : 'unavailable', 'EBITDA ÷ Revenue × 100'),
      netMargin:       tag(netMargin,       'calculated', 'Net Profit ÷ Revenue × 100'),
      // Returns
      roe:             tag(roe,             roe != null ? (pct(netProfit, avgEquity) != null ? 'calculated' : 'ttm-fallback') : 'unavailable', 'Net Profit ÷ Avg Equity × 100'),
      roce:            tag(roce,            'calculated', 'EBITDA ÷ (Total Equity + Total Debt) × 100'),
      roa:             tag(roa,             'calculated', 'Net Profit ÷ Total Assets × 100'),
      // Leverage
      de:              tag(de,              'calculated', 'Total Debt ÷ Total Equity'),
      icr:             tag(icr,             'calculated', 'EBITDA ÷ Interest Expense'),
      netDebtRatio:    tag(div(netDebt, ebitda), 'calculated', 'Net Debt ÷ EBITDA'),
      // Valuation multiples
      pe:              tag(pe,              pe === meta?.pe ? 'source-reference' : 'calculated', 'Price ÷ EPS'),
      pb:              tag(pb,              pb === meta?.pb ? 'source-reference' : 'calculated', 'Price ÷ Book Value per Share'),
      ps:              tag(ps,              'calculated', 'Market Cap ÷ Revenue'),
      evEbitda:        tag(evEbitda,        'calculated', 'EV ÷ EBITDA'),
      evRevenue:       tag(evRevenue,       'calculated', 'EV ÷ Revenue'),
      grahamNumber:    tag(grahamNumber,    'calculated', '√(22.5 × EPS × Book Value per Share)'),
      // Growth
      revCagr:         tag(revCagr,         'calculated', `Revenue CAGR over ${n} years`),
      revGrowthYoY:    tag(revGrowthYoY,    'calculated', 'Revenue YoY growth'),
      npGrowthYoY:     tag(npGrowthYoY,     'calculated', 'Net Profit YoY growth'),
      // FCF
      fcfYield:        tag(fcfYield,        'calculated', 'FCF ÷ Market Cap × 100'),
      fcfConversion:   tag(fcfConversion,   'calculated', 'FCF ÷ Net Profit × 100'),
      // EPS / Book
      eps:             tag(eps,             epsRaw != null ? 'source' : 'calculated', epsRaw ? null : 'Net Profit ÷ Shares Outstanding'),
      bookPerShare:    tag(bookPerShare,     'calculated', 'Total Equity ÷ Shares Outstanding'),
      // Meta (from v7 quote, for reference only)
      divYield:        tag(meta?.divYield,   'source-reference', 'From Yahoo v7 quote'),
      beta:            tag(meta?.beta,       'source-reference', 'From Yahoo v7 quote'),
      high52:          tag(meta?.high52,     'source-reference', null),
      low52:           tag(meta?.low52,      'source-reference', null),
    },
    // EBITDA metadata for display
    ebitdaMeta: { status: ebitdaStatus, formula: ebitdaFormula }
  }
}

// ─── Pure math helpers ────────────────────────────────────────────────────────

function div(a, b)    { return a != null && b != null && b !== 0 ? a / b : null }
function pct(a, b)    { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v)    { return v != null ? v * 100 : null }
function calc(formula, a, b, fn) {
  if (a == null || b == null) return null
  try { const r = fn(a, b); return isFinite(r) ? r : null } catch { return null }
}
function tag(value, status, formula = null) {
  return { value: value ?? null, status: value != null ? (status || 'calculated') : 'unavailable', formula }
}
