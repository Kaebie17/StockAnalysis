/**
 * src/engine/ratios.js
 *
 * ALL ratios computed from raw normalized data.
 */

export function calcRatios(data) {
  if (!data) return { ratios: {} }
  const { price, marketCap, shares: sharesRaw, incomeHistory = [], balanceHistory = [], cashflowHistory = [], ttm, meta } = data

  const latestI  = incomeHistory[incomeHistory.length - 1]   || {}
  const prevI    = incomeHistory[incomeHistory.length - 2]   || {}
  const oldestI  = incomeHistory[0]                          || {}
  const latestB  = balanceHistory[balanceHistory.length - 1]  || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}
  const n        = Math.max(0, incomeHistory.length - 1)

  const val = f => (f != null && typeof f === 'object' && 'value' in f) ? f.value : (typeof f === 'number' ? f : null)

  const revenue     = val(latestI.revenue)     ?? val(ttm?.revenue)
  const opProfit    = val(latestI.operatingProfit)
  const depreciation= val(latestI.depreciation)
  const interest    = val(latestI.interest)
  const netProfit   = val(latestI.netProfit)   ?? val(ttm?.netProfit)
  const totalEquity = val(latestB.totalEquity)
  const totalDebt   = val(latestB.totalDebt)   ?? val(ttm?.totalDebt) ?? 0
  const cash        = val(latestB.cash)        ?? val(ttm?.cash)       ?? 0
  const opCF        = val(latestCF.operatingCF) ?? val(ttm?.operatingCF)
  const fcf         = val(latestCF.freeCashFlow) ?? val(ttm?.freeCashFlow)
  const totalAssets = val(latestB.totalAssets)

  const shares = sharesRaw ?? (marketCap && price ? marketCap / price : null)
  const eps = val(latestI.eps) ?? val(ttm?.eps) ?? (netProfit && shares ? netProfit / shares : null)
  const ebitda = val(latestI.ebitda) ?? (opProfit != null && depreciation != null ? opProfit + depreciation : null) ?? val(ttm?.ebitda) ?? opProfit

  const ev = marketCap != null ? marketCap + totalDebt - cash : null
  const operatingMargin = pct(opProfit, revenue)
  const ebitdaMargin    = pct(ebitda, revenue)  ?? pct100(val(ttm?.ebitdaMargins))
  const netMargin       = pct(netProfit, revenue) ?? pct100(val(ttm?.profitMargins))
  
  const grossMargin = val(ttm?.grossMargins) != null 
    ? { value: val(ttm?.grossMargins) * 100, status: 'ttm-fallback', formula: 'From Yahoo' }
    : { value: operatingMargin, status: 'proxy', formula: 'Operating Profit Line Proxy' }

  const roe  = pct(netProfit, totalEquity) ?? pct100(val(ttm?.roe))
  const roce = pct(ebitda, totalEquity != null ? totalEquity + totalDebt : null)
  const netDebt = totalDebt - cash

  const bookPerShare = div(totalEquity, shares)
  const pe           = div(price, eps)           ?? meta?.pe
  const pb           = div(price, bookPerShare)  ?? meta?.pb
  const ps           = div(marketCap, revenue)
  const evEbitda     = div(ev, ebitda)

  const grahamNumber = eps > 0 && bookPerShare > 0 ? Math.sqrt(22.5 * eps * bookPerShare) : null
  const revCagr   = n > 0 && val(oldestI.revenue) > 0 && val(latestI.revenue) > 0 ? (Math.pow(val(latestI.revenue) / val(oldestI.revenue), 1 / n) - 1) * 100 : null

  return {
    price, marketCap, ev, shares, revenue, opProfit, ebitda, netProfit, interest, totalEquity, totalDebt, cash, netDebt, fcf, opCF, eps, bookPerShare, grahamNumber,
    ratios: {
      grossMargin,
      operatingMargin: tag(operatingMargin, 'calculated', 'Operating Profit ÷ Revenue × 100'),
      ebitdaMargin:    tag(ebitdaMargin,    'calculated', 'EBITDA ÷ Revenue × 100'),
      netMargin:       tag(netMargin,       'calculated', 'Net Profit ÷ Revenue × 100'),
      roe:             tag(roe,             'calculated', 'Net Profit ÷ Equity × 100'),
      roce:            tag(roce,            'calculated', 'EBITDA ÷ Capital Employed × 100'),
      de:              tag(div(totalDebt, totalEquity), 'calculated', 'Total Debt ÷ Equity'),
      pe:              tag(pe,              'calculated', 'Price ÷ EPS'),
      pb:              tag(pb,              'calculated', 'Price ÷ Book Value'),
      ps:              tag(ps,              'calculated', 'Market Cap ÷ Revenue'),
      evEbitda:        tag(evEbitda,        'calculated', 'EV ÷ EBITDA'),
      grahamNumber:    tag(grahamNumber,    'calculated', 'Graham Intrinsic Base Rule'),
      revCagr:         tag(revCagr,         'calculated', 'Revenue Multi-year CAGR'),
    }
  }
}

function div(a, b)    { return a != null && b != null && b !== 0 ? a / b : null }
function pct(a, b)    { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v)    { return v != null ? v * 100 : null }
function tag(value, status, formula = null) { return { value: value ?? null, status: value != null ? status : 'unavailable', formula } }