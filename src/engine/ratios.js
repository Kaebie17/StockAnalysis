// ratios.js
// ALL derived ratios calculated here from normalized raw data
// Nothing pulled from source — every formula is ours to control
// For Yahoo Finance: balance sheet history is sparse so we supplement with
// pre-calculated TTM ratios from financialData (stored in data.ttm)

export const RATIO_FORMULAS = {
  pe:           'Price / EPS',
  pb:           'Price / Book Value Per Share',
  ps:           'Market Cap / Revenue',
  ev:           'Market Cap + Total Debt - Cash',
  evEbitda:     'EV / EBITDA',
  evGrossProfit:'EV / Gross Profit',
  grossMargin:  'Gross Profit / Revenue × 100',
  ebitdaMargin: 'EBITDA / Revenue × 100',
  netMargin:    'Net Income / Revenue × 100',
  roe:          'Net Income / Total Equity × 100',
  roa:          'Net Income / Total Assets × 100',
  roce:         'EBIT / (Total Assets - Current Liabilities) × 100',
  deRatio:      'Total Debt / Total Equity',
  fcfConversion:'FCF / Net Income × 100',
  fcfYield:     'FCF / Market Cap × 100',
  dividendYield:'(-Dividends Paid) / Market Cap × 100',
  grahamNumber: '√(22.5 × EPS × Book Value Per Share)',
}

export function calculateRatios(data) {
  const { latest, marketCap, price } = data
  // ttm holds Yahoo financialData TTM ratios when balance sheet history is sparse
  const ttm = data.ttm ?? null

  const {
    revenue, grossProfit, ebitda, ebit,
    netIncome, eps, totalAssets, totalDebt,
    totalEquity, cash, bookValuePerShare,
    cfo, fcf, dividendsPaid,
  } = latest

  const mktCap = marketCap ?? latest.marketCap

  // Enterprise Value
  const evVal = (mktCap != null && totalDebt != null && cash != null)
    ? mktCap + totalDebt - cash
    : (mktCap != null && totalDebt != null)
    ? mktCap + totalDebt                 // cash unknown — conservative
    : null

  // D/E: try calculated first, then Yahoo TTM pre-calculated
  const deRatioCalc = safeDivide(totalDebt, totalEquity)
  const deRatio     = deRatioCalc ?? ttm?.debtToEquity ?? null

  // ROE: try calculated, then Yahoo TTM (stored as decimal e.g. 0.112 → 11.2%)
  const roeCalc = safePercent(netIncome, totalEquity)
  const roe     = roeCalc ?? (ttm?.roe != null ? ttm.roe * 100 : null)

  // ROA: try calculated, then Yahoo TTM
  const roaCalc = safePercent(netIncome, totalAssets)
  const roa     = roaCalc ?? (ttm?.roa != null ? ttm.roa * 100 : null)

  // ROCE: proxy using EBIT / total capital (debt + equity)
  // When totalAssets null: use totalDebt + implied equity from D/E
  let roce = null
  if (ebit != null && totalAssets != null && totalEquity != null) {
    roce = safePercent(ebit, totalAssets - totalEquity)
  } else if (ebit != null && totalDebt != null && deRatio != null && deRatio > 0) {
    const impliedEquity = totalDebt / deRatio
    roce = safePercent(ebit, totalDebt + impliedEquity)
  }

  // Gross margin: try calculated, then Yahoo TTM (stored as decimal 0.478 → 47.8%)
  const grossMarginCalc = safePercent(grossProfit, revenue)
  const grossMargin     = grossMarginCalc ?? (ttm?.grossMargin != null ? ttm.grossMargin * 100 : null)

  // EBITDA margin: try calculated, then Yahoo TTM
  const ebitdaMarginCalc = safePercent(ebitda, revenue)
  const ebitdaMargin     = ebitdaMarginCalc ?? (ttm?.ebitdaMargin != null ? ttm.ebitdaMargin * 100 : null)

  // Net margin: try calculated, then Yahoo TTM
  const netMarginCalc = safePercent(netIncome, revenue)
  const netMargin     = netMarginCalc ?? (ttm?.netMargin != null ? ttm.netMargin * 100 : null)

  return {
    pe:            safeDivide(price, eps),
    pb:            safeDivide(price, bookValuePerShare),
    ps:            safeDivide(mktCap, revenue),
    ev:            evVal,
    evEbitda:      safeDivide(evVal, ebitda),
    evGrossProfit: safeDivide(evVal, grossProfit),
    grossMargin,
    ebitdaMargin,
    netMargin,
    roe,
    roa,
    roce,
    deRatio,
    fcfConversion: safePercent(fcf, netIncome),
    fcfYield:      safePercent(fcf, mktCap),
    dividendYield: dividendsPaid && mktCap ? safePercent(-dividendsPaid, mktCap) : null,
    grahamNumber:  grahamNumber(eps, bookValuePerShare),
  }
}

// ── Historical ratios for trend charts ───────────────────

export function calculateHistoricalRatios(data) {
  const { incomeHistory, balanceHistory, cashflowHistory } = data

  return incomeHistory.map((inc, i) => {
    const bal = balanceHistory[i] ?? {}
    const cf  = cashflowHistory[i] ?? {}
    return {
      date:         inc.date,
      grossMargin:  safePercent(inc.grossProfit, inc.revenue),
      ebitdaMargin: safePercent(inc.ebitda, inc.revenue),
      netMargin:    safePercent(inc.netIncome, inc.revenue),
      roe:          safePercent(inc.netIncome, bal.totalEquity),
      deRatio:      safeDivide(bal.totalDebt, bal.totalEquity),
      fcfConversion:safePercent(cf.fcf, inc.netIncome),
      revenue:      inc.revenue,
      netIncome:    inc.netIncome,
      fcf:          cf.fcf,
      ebitda:       inc.ebitda,
    }
  }).reverse() // oldest first for charts
}

// ── Revenue CAGR ──────────────────────────────────────────

export function revenueCAGR(incomeHistory, years = 5) {
  const sorted = [...incomeHistory].sort((a, b) => new Date(b.date) - new Date(a.date))
  const n      = Math.min(years, sorted.length - 1)
  if (n < 1) return null
  const latest = sorted[0].revenue
  const oldest = sorted[n].revenue
  if (!latest || !oldest || oldest <= 0) return null
  return (Math.pow(latest / oldest, 1 / n) - 1) * 100
}

// ── Helpers ───────────────────────────────────────────────

function safeDivide(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null
  return numerator / denominator
}

function safePercent(numerator, denominator) {
  const r = safeDivide(numerator, denominator)
  return r == null ? null : r * 100
}

function grahamNumber(eps, bvps) {
  if (!eps || !bvps || eps <= 0 || bvps <= 0) return null
  return Math.sqrt(22.5 * eps * bvps)
}
