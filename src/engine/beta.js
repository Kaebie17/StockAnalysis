/**
 * src/engine/beta.js — this app's own beta, computed by regression instead
 * of trusted from a single vendor's fixed-window figure.
 *
 * Every CAPM consumer here used to read beta straight from Yahoo's `quote`
 * endpoint (requiredReturn.js) — a black box: fixed window, undisclosed
 * benchmark, no visibility into which months drove it. Live-testing on
 * RELIANCE surfaced a real case: Yahoo and investing.com both report
 * beta ~0.15-0.18 (a 5-year figure), while Moneycontrol (0.94) and
 * Trendlyne's shorter windows (0.9-1.2 across 1mo/3mo/1yr/3yr) do not
 * agree. The split lines up exactly with window length, not source
 * quality — RELIANCE's 2020 Jio-stake-sale rally ran largely decoupled
 * from the broader COVID-era market, and that one multi-month episode
 * dominates a 60-point regression the way it can no longer dominate a
 * 12-36 point one. A fixed vendor window hides that; a regression we can
 * see and re-window over doesn't.
 *
 * Reuses fitLine() from targetMultiple.js (already a working OLS fit with
 * slope/r2/n) rather than reimplementing regression math — beta is just
 * that function's slope when x = index return, y = stock return.
 */

import { fitLine } from './targetMultiple.js'

const MS_DAY = 86400000

/** One close per calendar month — the last trading day on/before month-end. */
function toMonthlyCloses(rows) {
  const byMonth = new Map()
  for (const r of rows || []) {
    if (!(r?.close > 0) || !r?.date) continue
    const t = Date.parse(r.date)
    if (!isFinite(t)) continue
    const d = new Date(t)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const prev = byMonth.get(key)
    if (!prev || t > prev.t) byMonth.set(key, { t, close: r.close, key })
  }
  return [...byMonth.values()].sort((a, b) => a.t - b.t)
}

/** Month-over-month simple returns, keyed by the LATER month's 'YYYY-MM'. */
function toReturns(monthly) {
  const out = []
  for (let i = 1; i < monthly.length; i++) {
    const a = monthly[i - 1].close, b = monthly[i].close
    if (a > 0 && b > 0) out.push({ key: monthly[i].key, ret: b / a - 1 })
  }
  return out
}

// A regression on fewer than a year of paired months is dominated by
// whichever handful of months happen to be in it — not enough to call a
// beta. Below this, degrade to the Yahoo-fallback path (requiredReturn.js)
// rather than report a number built on too little.
export const MIN_PAIRED_MONTHS = 12

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

/**
 * Regression beta: slope of stock monthly returns on index monthly
 * returns, over the trailing `years` window. Aligns by calendar month
 * (not by matching row index) so a stock and index with slightly
 * different trading-day closes still pair correctly.
 *
 * Never substitutes a different number when the fit is weak (a low r² is
 * disclosed via the returned `r2`, not hidden) — only an outright lack of
 * enough paired history declines to produce a beta at all.
 */
export function computeBeta(stockPriceHistory = [], indexPriceHistory = [], { years = 5, indexLabel = 'the index' } = {}) {
  const cutoff = Date.now() - years * 365.25 * MS_DAY
  const inWindow = rows => (rows || []).filter(r => r?.close > 0 && Date.parse(r.date) >= cutoff)

  const stockM = toMonthlyCloses(inWindow(stockPriceHistory))
  const indexM = toMonthlyCloses(inWindow(indexPriceHistory))
  const stockR = toReturns(stockM)
  const indexByKey = new Map(toReturns(indexM).map(r => [r.key, r.ret]))

  const points = []
  for (const s of stockR) {
    const x = indexByKey.get(s.key)
    if (x != null) points.push({ x, y: s.ret })
  }

  if (points.length < MIN_PAIRED_MONTHS) {
    return {
      beta: null, n: points.length, years,
      insufficientReason: `Only ${points.length} paired month${points.length === 1 ? '' : 's'} of stock ` +
        `and index history over a ${years}yr window — need at least ${MIN_PAIRED_MONTHS}.`,
    }
  }

  const fit = fitLine(points)
  if (!fit || fit.slope == null) {
    return { beta: null, n: points.length, years, insufficientReason: 'Regression could not be fit.' }
  }

  return {
    beta: fit.slope, r2: round(fit.r2, 2), n: fit.n, years,
    label: `${fit.n}-month regression vs ${indexLabel}, ${years}yr window, r² ${round(fit.r2, 2)}`,
  }
}
