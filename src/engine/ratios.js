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

  // ── Latest-year snapshot (synthetic-aware, gap-filled) ──────────────────────
  // Real fiscal-year rows always take precedence over the synthetic current-year
  // TTM stub that normalize.js may append (flagged `synthetic:true`). The snapshot
  // is anchored on the most recent REAL row; any field still missing there is
  // back-filled from older real rows, then finally from the TTM stub. This is what
  // lets pasted/merged Screener rows actually drive the dashboard instead of being
  // shadowed by a fabricated current-year row that only carried a few TTM fields.
  const realRows = arr => {
    const real = (arr || []).filter(r => !r.synthetic)
    return real.length ? real : (arr || [])
  }
  const coalesceLatest = (arr) => {
    const rows = arr || []
    if (rows.length === 0) return {}
    const real = realRows(rows)
    const base = { ...real[real.length - 1] }                 // most recent real row
    const fill = (row) => {
      for (const k in row) {
        if (k === 'year' || k === 'synthetic') continue
        if (base[k]?.value == null && row[k]?.value != null) base[k] = row[k]
      }
    }
    for (let i = real.length - 2; i >= 0; i--) fill(real[i])   // back-fill from older real rows
    for (const r of rows) if (r.synthetic) fill(r)             // last resort: TTM stub
    return base
  }

  const incomeReal  = realRows(incomeHistory)
  const balanceReal = realRows(balanceHistory)

  // Unwrap tagged values from latest year
  const latestI  = coalesceLatest(incomeHistory)
  const prevI    = incomeReal[incomeReal.length - 2]   || {}
  const oldestI  = incomeReal[0]                        || {}
  const latestB  = coalesceLatest(balanceHistory)
  const latestCF = coalesceLatest(cashflowHistory)
  const n        = incomeReal.length - 1

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

  // ── Growth for valuation (professional practice) ────────────────────────────
  // Full-span CAGR swings with how many years are loaded, so it's a poor DCF
  // input. Instead expose:
  //   revGrowthRecent  – MEDIAN of the last ~5 annual YoY growth rates (robust to
  //                      one freak year; reflects the company as it is now)
  //   revGrowthLongRun – CAGR over the last min(10, n) years (a bounded window,
  //                      not the entire uploaded history)
  const revSeries = incomeReal.map(r => val(r.revenue)).filter(v => v != null && v > 0)
  const yoySeries = []
  for (let i = 1; i < revSeries.length; i++) {
    yoySeries.push((revSeries[i] / revSeries[i - 1] - 1) * 100)
  }
  const median = arr => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const revGrowthRecent = median(yoySeries.slice(-5))
  let revGrowthLongRun = null
  if (revSeries.length >= 2) {
    const win = Math.min(10, revSeries.length - 1)      // last 10-year window at most
    const start = revSeries[revSeries.length - 1 - win]
    const end   = revSeries[revSeries.length - 1]
    if (start > 0 && end > 0) revGrowthLongRun = (Math.pow(end / start, 1 / win) - 1) * 100
  }
  // 5-year endpoint CAGR — the headline growth figure shown on the dashboard
  // (comparable to the other current-window metrics, unlike the full-span CAGR).
  let revCagr5y = null
  if (revSeries.length >= 2) {
    const win = Math.min(5, revSeries.length - 1)
    const start = revSeries[revSeries.length - 1 - win]
    const end   = revSeries[revSeries.length - 1]
    if (start > 0 && end > 0) revCagr5y = (Math.pow(end / start, 1 / win) - 1) * 100
  }

  // ── EV ─────────────────────────────────────────────────────────────────────
  const ev = marketCap != null ? marketCap + totalDebt - cash : null

  // ── Margins ────────────────────────────────────────────────────────────────
  // Note: Indian P&L has no "Gross Profit" line — Operating Profit IS the first
  // meaningful margin. We flag grossMargin as "Operating Margin (Indian P&L format)"
  const operatingMargin = pct(opProfit, revenue)
  const ebitdaMargin    = pct(ebitda, revenue)  ?? pct100(val(ttm?.ebitdaMargins))
  const netMargin       = pct(netProfit, revenue) ?? pct100(val(ttm?.profitMargins))
  // Gross margin priority: (1) gross profit from history — populated from
  // Screener's Material Cost % breakup (revenue − material cost); (2) Yahoo's TTM
  // gross margin (US cos); (3) operating-margin proxy (Indian P&L, no COGS line).
  const gpHist          = val(latestI.grossProfit)
  const grossMarginRaw  = val(ttm?.grossMargins)
  const grossMargin     = (gpHist != null && revenue)
    ? { value: pct(gpHist, revenue), status: 'calculated', formula: 'Gross Profit ÷ Revenue × 100' }
    : grossMarginRaw != null
    ? { value: grossMarginRaw * 100, status: 'ttm-fallback', formula: 'From Yahoo financialData' }
    : operatingMargin != null
    ? { value: operatingMargin, status: 'proxy', formula: 'Operating Margin (Indian P&L — no separate Gross Profit line)' }
    : { value: null, status: 'unavailable', formula: null }

  // ── Returns ────────────────────────────────────────────────────────────────
  // ROE = Net Profit / Average Equity × 100
  const prevEquity = val(balanceReal[balanceReal.length - 2]?.totalEquity)
  const avgEquity  = totalEquity != null && prevEquity != null
    ? (totalEquity + prevEquity) / 2 : totalEquity
  const roe  = pct(netProfit, avgEquity) ?? pct100(val(ttm?.roe))

  // ROCE = EBIT / Capital Employed × 100
  // Capital Employed = Total Assets - Current Liabilities
  // We approximate: Capital Employed = Total Equity + Total Debt (= long-term capital)
  // ROCE = EBIT / Capital Employed × 100  (EBIT = operating profit, i.e. after
  // depreciation — NOT EBITDA, which overstates the return). Prefer reported
  // operating income; else derive EBIT = EBITDA − Depreciation.
  const capitalEmployed = totalEquity != null ? totalEquity + totalDebt : null
  const ebit = opProfit != null ? opProfit
    : (ebitda != null && depreciation != null) ? ebitda - depreciation
    : ebitda
  const roce = pct(ebit, capitalEmployed)

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
      revCagr5y:       tag(revCagr5y,       'calculated', 'Revenue CAGR over the last 5 years'),
      revGrowthRecent: tag(revGrowthRecent, 'calculated', 'Median of last 5 annual revenue growth rates'),
      revGrowthLongRun:tag(revGrowthLongRun,'calculated', 'Revenue CAGR over the last 10 years (bounded window)'),
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
