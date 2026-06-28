// ratios.js
// ALL derived ratios calculated here from normalized raw data
// Nothing is pulled from API — we control every formula
// Formulas are stored as strings so they can be displayed and edited in the UI

export const RATIO_FORMULAS = {
  pe:           'Price / EPS',
  pb:           'Price / Book Value Per Share',
  ps:           'Market Cap / Revenue',
  ev:           'Market Cap + Total Debt - Cash',
  evEbitda:     'EV / EBITDA',
  evGrossProfit:'EV / Gross Profit',
  grossMargin:  'Gross Profit / Revenue',
  ebitdaMargin: 'EBITDA / Revenue',
  netMargin:    'Net Income / Revenue',
  roe:          'Net Income / Total Equity',
  roa:          'Net Income / Total Assets',
  roce:         'EBIT / (Total Assets - Total Equity)',  // proxy for capital employed
  deRatio:      'Total Debt / Total Equity',
  currentRatio: 'Current Assets / Current Liabilities',  // not always available
  interestCov:  'EBIT / Interest Expense',
  fcfConversion:'FCF / Net Income',
  fcfYield:     'FCF / Market Cap',
  dividendYield:'(Dividends Paid * -1) / Market Cap',
  grahamNumber: 'sqrt(22.5 * EPS * Book Value Per Share)',
}

export function calculateRatios(data) {
  const { latest, marketCap, price } = data

  const {
    revenue, grossProfit, ebitda, ebit,
    netIncome, eps, totalAssets, totalDebt,
    totalEquity, cash, bookValuePerShare,
    cfo, fcf, dividendsPaid,
  } = latest

  const mktCap = marketCap ?? latest.marketCap

  // Enterprise Value
  const ev = safeDivide(
    (mktCap ?? 0) + (totalDebt ?? 0) - (cash ?? 0),
    1 // not a division — just a sum
  , true)

  const evVal = (mktCap != null && totalDebt != null && cash != null)
    ? mktCap + totalDebt - cash
    : null

  return {
    pe:            safeDivide(price, eps),
    pb:            safeDivide(price, bookValuePerShare),
    ps:            safeDivide(mktCap, revenue),
    ev:            evVal,
    evEbitda:      safeDivide(evVal, ebitda),
    evGrossProfit: safeDivide(evVal, grossProfit),
    grossMargin:   safePercent(grossProfit, revenue),
    ebitdaMargin:  safePercent(ebitda, revenue),
    netMargin:     safePercent(netIncome, revenue),
    roe:           safePercent(netIncome, totalEquity),
    roa:           safePercent(netIncome, totalAssets),
    roce:          safePercent(ebit, totalAssets != null && totalEquity != null ? totalAssets - totalEquity : null),
    deRatio:       safeDivide(totalDebt, totalEquity),
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
  const latest  = sorted[0].revenue
  const oldest  = sorted[n].revenue
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
