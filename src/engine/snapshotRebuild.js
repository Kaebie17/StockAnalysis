/**
 * src/engine/snapshotRebuild.js — what the app would have said on a past date.
 *
 * A position entered retrospectively has no baseline: nothing was recorded when
 * the shares were actually bought. Backfilling with today's numbers makes the
 * estimate-vs-price bar read a flat zero for every such holding, which is not
 * merely unhelpful — it looks like a real finding.
 *
 * Most of a baseline is recoverable, because most of it is historical fact:
 *
 *   price       exact, from priceHistory on that date
 *   financials  annual statements don't change intra-year, so the FY that had
 *               REPORTED by that date is knowable
 *   multiple    recomputable from closes up to that date only
 *   market      VIX and index level, where the series reach back that far
 *
 * What cannot be recovered is anything the user would have judged: guidance they
 * would have entered, revisions they would have accepted. So the result is the
 * MECHANICAL estimate of that date and is tagged `reconstructed`, never
 * `observed`. The distinction matters when the bar is later read as evidence.
 */
import { buildEstimate } from './estimate.js'

const val = t => (t && typeof t === 'object' ? t.value : t)
/** Revenue CAGR over whatever years had been published by the rebuild date. */
function cagrOf(rows = []) {
  const pts = rows
    .map(r => ({ y: yearOf(r), v: val(r?.revenue) }))
    .filter(p => p.y != null && p.v > 0)
    .sort((a, b) => a.y - b.y)
  if (pts.length < 3) return null
  const years = pts[pts.length - 1].y - pts[0].y
  if (years < 2) return null
  const g = Math.pow(pts[pts.length - 1].v / pts[0].v, 1 / years) - 1
  if (!isFinite(g) || g > 0.6 || g < -0.3) return null
  return g * 100
}

const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

/**
 * Statements a user could actually have seen on `asOfMs`.
 *
 * Indian annual results land months after the fiscal year ends — FY26 (to March
 * 2026) is typically published between May and August. Treating FY26 as known in
 * April 2026 would build the baseline from a filing nobody had, so a reporting
 * lag is applied and the year is only included once it had plausibly been
 * published.
 */
export function historyAsOf(incomeHistory = [], asOfMs, opts = {}) {
  const { fyEndMonth = 3, reportingLagMonths = 4 } = opts
  const asOf = new Date(asOfMs)
  return (incomeHistory || []).filter(row => {
    const y = yearOf(row)
    if (y == null) return false
    // FY ending March `y` is assumed public `reportingLagMonths` after that.
    const publishedAt = new Date(Date.UTC(y, fyEndMonth - 1 + reportingLagMonths, 1))
    return publishedAt.getTime() <= asOf.getTime()
  })
}

/** Closes up to a date — so the multiple band can't see the future. */
export function priceHistoryAsOf(priceHistory = [], asOfMs) {
  return (priceHistory || []).filter(p => {
    const t = Date.parse(p?.date)
    return isFinite(t) && t <= asOfMs
  })
}

/** The traded price on (or immediately before) a date. */
export function priceOn(priceHistory = [], asOfMs) {
  const rows = priceHistoryAsOf(priceHistory, asOfMs)
    .filter(p => p.close > 0)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  return rows.length ? rows[rows.length - 1].close : null
}

/**
 * Rebuild a purchase snapshot.
 *
 * @param analysis  cached analysis for the ticker { ratioResult, data, quality }
 * @param asOfMs    purchase date
 * @param regimeOn  { vix, indexLevel, missing[] } from fetchRegimeOn — optional
 * @returns snapshot object, or null when the date predates available data
 */
export function rebuildSnapshot(analysis, asOfMs, regimeOn = null) {
  if (!analysis?.ratioResult || !isFinite(asOfMs)) return null

  const priceHistory = analysis.data?.priceHistory || []
  const incomeHistory = analysis.data?.incomeHistory || []

  const price = priceOn(priceHistory, asOfMs)
  const incAsOf = historyAsOf(incomeHistory, asOfMs)
  const missing = [...(regimeOn?.missing || [])]

  // Without a price on that date there is no baseline worth having — every
  // comparison downstream is against it.
  if (!(price > 0)) return null

  // Rebuild the ratio inputs from the statements of the time. EPS and revenue
  // come from the last year that had reported; the rest of ratioResult is
  // carried over, since it's either price-derived (recomputed below) or slow
  // enough that using today's is a smaller error than dropping the snapshot.
  const lastRow = incAsOf[incAsOf.length - 1]
  const epsThen = val(lastRow?.eps) ?? analysis.ratioResult.eps
  const revThen = val(lastRow?.revenue) ?? analysis.ratioResult.revenue
  const npThen  = val(lastRow?.netProfit) ?? analysis.ratioResult.netProfit

  if (incAsOf.length === 0) missing.push('financials as of that date')

  // Ratios AS OF that date, not today's.
  //
  // Spreading the current `ratios` object through recomputed price/EPS/revenue
  // left ROE, margin, book value and payout at their present-day values while
  // everything around them described the past — and those four drive the
  // estimate. A company whose ROE has since improved got its improved ROE
  // applied to a two-year-old price, which is the same error as freezing a
  // payout: a quantity held still while the things it belongs with moved.
  const bRow = (analysis.data?.balanceHistory || []).find(b => yearOf(b) === yearOf(lastRow))
  const equityThen = val(bRow?.totalEquity)
  const sharesThen = (npThen > 0 && epsThen > 0) ? npThen / epsThen : null
  const bpsThen = (equityThen > 0 && sharesThen > 0) ? equityThen / sharesThen : null
  const divThen = val(lastRow?.dividendPaid) ?? val(lastRow?.dividend)

  const ratioThen = {
    ...analysis.ratioResult,
    price, eps: epsThen, revenue: revThen, netProfit: npThen,
    ratios: {
      ...analysis.ratioResult.ratios,
      // Each recomputed from the figures of that year where they exist; where
      // they don't, today's is kept and the gap is named in `missing` below.
      pe:  (epsThen > 0) ? { value: price / epsThen } : analysis.ratioResult.ratios?.pe,
      roe: (equityThen > 0 && npThen > 0)
        ? { value: (npThen / equityThen) * 100 } : analysis.ratioResult.ratios?.roe,
      netMargin: (revThen > 0 && npThen != null)
        ? { value: (npThen / revThen) * 100 } : analysis.ratioResult.ratios?.netMargin,
      bookPerShare: bpsThen > 0 ? { value: bpsThen } : analysis.ratioResult.ratios?.bookPerShare,
      pb: (bpsThen > 0) ? { value: price / bpsThen } : analysis.ratioResult.ratios?.pb,
      dividendPayout: (divThen >= 0 && npThen > 0)
        ? { value: (divThen / npThen) * 100 } : analysis.ratioResult.ratios?.dividendPayout,
    },
  }

  // Growth as of that date too. The ratios above were recomputed but the CAGR
  // fields were still today's — so a rebuild used the growth rate measured over
  // years that hadn't happened yet at the date being rebuilt. Recomputed from
  // the years actually published by then; where there are too few, the field is
  // dropped so the estimate declines rather than borrowing a future number.
  const cagrThen = cagrOf(incAsOf)
  for (const k of ['revCagr5y', 'revGrowthRecent', 'revCagr', 'revGrowthLongRun']) {
    if (cagrThen != null) ratioThen.ratios[k] = { value: cagrThen }
    else delete ratioThen.ratios[k]
  }

  if (!(equityThen > 0)) missing.push('book value as of that date')
  if (cagrThen == null) missing.push('growth history as of that date')

  const est = buildEstimate(ratioThen, {
    priceHistory:   priceHistoryAsOf(priceHistory, asOfMs),
    incomeHistory:  incAsOf.length ? incAsOf : incomeHistory,
    balanceHistory: analysis.data?.balanceHistory || [],
  })

  if (!est?.ok) return null

  return {
    takenAt: asOfMs,
    reconstructed: true,          // mechanical rebuild, not an observed reading
    isLate: true,                 // still not a live capture at purchase
    backfilled: false,            // but no longer a same-day stub either
    price,
    currency: analysis.data?.currency ?? null,
    estimate: {
      low: est.target.low, base: est.target.base, high: est.target.high,
      growthPct: est.growthPct, marginPct: est.marginPct,
      multipleBase: est.multiples?.base ?? null,
      basisSummary: est.basisSummary,
    },
    qualityScore: analysis.quality?.score ?? null,
    marketImpliedGrowth: analysis.valuation?.impliedGrowth ?? null,
    // Market conditions entered in — what separates the stock's performance
    // from the market's.
    vix: regimeOn?.vix ?? null,
    indexLevel: regimeOn?.indexLevel ?? null,
    // Named gaps, so the UI can say what wasn't available instead of implying a
    // complete record.
    missing: missing.length ? missing : undefined,
    yearsKnownThen: incAsOf.length,
  }
}

/**
 * Performance split into what the market did and what the company did.
 *
 * The honest reading of a holding's return: up 18% while the index rose 11% is a
 * 7% contribution from the business, and buying at elevated volatility means
 * part of the rest was the market recovering rather than the pick working.
 */
export function benchmarkReturn(snapshot, currentPrice, currentIndex) {
  const p0 = snapshot?.price, i0 = snapshot?.indexLevel
  if (!(p0 > 0) || !(currentPrice > 0)) return null
  const stockPct = ((currentPrice - p0) / p0) * 100
  if (!(i0 > 0) || !(currentIndex > 0)) {
    return { stockPct: round(stockPct), indexPct: null, alphaPct: null,
             note: 'No index level recorded for the entry date — this is the raw move, not a comparison.' }
  }
  const indexPct = ((currentIndex - i0) / i0) * 100
  return {
    stockPct: round(stockPct), indexPct: round(indexPct),
    alphaPct: round(stockPct - indexPct),
    vixThen: snapshot.vix ?? null,
  }
}

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
