/**
 * src/engine/estimate.js — the app's OWN estimate.
 *
 * Different from fair value, and the difference is the point. Fair value is a
 * live derived output: feed it today's numbers and it recomputes from scratch.
 * It's never wrong because it never claimed anything. An estimate is a dated
 * claim — "as of this date, on this basis, this can reach X–Y" — frozen, stored,
 * and later checked against what actually happened. It CAN be wrong, and a model
 * that can't be wrong can't be corrected either.
 *
 * The chain, in plain terms:
 *   revenue × growth         → next year's revenue
 *   × margin                 → next year's profit
 *   ÷ shares (incl dilution) → next year's EPS
 *   × what buyers pay        → price range
 *
 * Every one of those inputs has a LADDER: best available basis, then weaker
 * fallbacks. The estimate always produces a number while the arithmetic is
 * possible, and always reports which rung each input stood on. It never silently
 * degrades — a figure that quietly switches to a weaker basis while looking
 * identical is how someone trusts a number they'd otherwise have questioned.
 */

import { targetMultiple } from './targetMultiple.js'
import { justifiedMultiples, preferredForm } from './justifiedMultiple.js'

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)

// Sanity bounds on an OBSERVED daily ratio, not on what a company may trade at.
//
// These were a fixed 5-60x, which threw away real observations: Trent trades
// near 117x, so every legitimate day of its history was discarded and the
// distorted ones kept. A ceiling on what the market is allowed to pay is a
// judgement I have no basis for.
//
// What remains is only an outlier filter, and it is measured from the stock's
// own distribution rather than chosen: a ratio more than 4x the median, or less
// than a quarter of it, is a data artefact (a mid-year EPS restatement, a stub
// year) rather than a price anyone paid.
const OUTLIER_MULTIPLE = 4
// Range width when no measured band exists.
//
// A fixed ±25% says the same thing about every company, which is never true: a
// steadily-rated business and a volatile one deserve different widths. So the
// width is taken from how much the stock's own PRICE has actually varied, which
// exists even when a multiple band doesn't — that only needs closes, not the
// paired annual earnings a band requires.
//
// There is no last-resort width. A stock with no usable price history has
// nothing from which to measure one, and inventing a figure produces a range
// that looks measured and isn't — the same fault as every other fixed number
// removed from this file. Where dispersion can't be measured, the market-based
// estimate simply isn't produced; Estimate 1 needs no price history and carries
// that case.

/**
 * Half-width for a fallback range, from the stock's own price dispersion.
 * Returns null when there isn't enough history to measure one.
 */
function priceDispersion(priceHistory = [], days = 500) {
  const cutoff = Date.now() - days * 86400000
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0 && Date.parse(p.date) >= cutoff)
    .map(p => p.close)
  if (closes.length < 100) return null
  const sorted = [...closes].sort((a, b) => a - b)
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
  const med = q(0.5)
  if (!(med > 0)) return null
  // The 15th-85th band as a fraction of the median, halved to a ± figure.
  const half = ((q(0.85) - q(0.15)) / med) / 2

  // A steadily-priced stock genuinely has a narrow dispersion, and rejecting it
  // for being small was the same mistake as capping a high P/E — it discarded
  // the correct reading. Only a truly degenerate value (a flat series, or one
  // so wide the sample must span two regimes) is refused; the rest is used, with
  // a small floor so a range never collapses to a single number.
  if (!(half > 0) || half > 1) return null
  return Math.max(half, 0.03)
}

// A one-off share-count jump — a merger, a large QIP — must not be projected
// forward as if it recurs annually. The previous version clamped the RESULT at
// 10%/yr, which both understated a company genuinely issuing 15% a year and
// still let a single merger drag the rate up to the cap.
//
// Excluding the one-off is the correct treatment: a year whose share count
// jumps far more than the company's own norm is a discrete event, not a rate,
// so it is dropped from the series rather than capping what the series yields.
// The threshold is relative to the stock's own median annual change.
const ONE_OFF_MULTIPLE = 4

const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

/**
 * What buyers have paid for a year of FORWARD earnings.
 *
 * This fixes a real error in the first version, which measured a TRAILING
 * multiple (price ÷ the same year's EPS) and then applied it to NEXT year's EPS.
 * Those are different animals: if the market pays 28× trailing and the company
 * grows 20%, quoting "28× next year's earnings" overstates the price by exactly
 * that 20% — and overstates most for the fastest growers, precisely where an
 * optimistic bias does the most damage. Analysts say "forward P/E" for this
 * reason.
 *
 * So for each fiscal year, divide that year's daily closes by the EPS of the
 * FOLLOWING year: what buyers were paying, at the time, for earnings that hadn't
 * arrived yet. That is the multiple a forward EPS can legitimately be multiplied
 * by.
 */
/**
 * What buyers have paid for a year of FORWARD earnings.
 *
 * Uses REPORTED earnings, not normalised ones. The market set those prices while
 * looking at the reported figures — including whatever exceptional item was in
 * them — so dividing historical prices by a normalised EPS measures a multiple
 * nobody ever paid. The projection this band is applied to uses normalised
 * earnings, correctly: one describes past market behaviour, the other forecasts
 * the underlying business.
 *
 * Callers pass `reportedIncomeHistory` where it exists; where it doesn't, the
 * two are identical and nothing changes.
 */
export function forwardPeBand(priceHistory = [], incomeHistory = [], opts = {}) {
  const { fyEndMonth = 3 } = opts

  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (closes.length === 0) return null

  const epsByYear = new Map()
  for (const row of incomeHistory || []) {
    const y = yearOf(row), e = val(row?.eps)
    if (y != null && e > 0) epsByYear.set(y, e)
  }

  const ratios = []
  let pairedYears = 0
  for (const [y] of epsByYear) {
    const nextEps = epsByYear.get(y + 1)
    if (!(nextEps > 0)) continue                  // no forward year to price against
    const end   = Date.UTC(y, fyEndMonth, 0)
    const start = Date.UTC(y - 1, fyEndMonth, 1)
    let any = false
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      const pe = c.close / nextEps
      if (pe > 0) { ratios.push(pe); any = true }
    }
    if (any) pairedYears++
  }

  // Diagnose WHY a band can't be built, because the two causes need different
  // fixes and the UI has been reporting the wrong one. Extending the price
  // fetch to ten years did nothing for a stock whose incomeHistory carries four
  // annual rows: this pairs each year's prices with the NEXT year's EPS, so N
  // years of earnings yield at most N-1 usable pairs however many prices exist.
  // Two paired years — the arithmetic minimum, not a judgement.
  //
  // A percentile needs a distribution; one year gives a single point with no
  // low and no high. Every threshold above that was me deciding what counts as
  // "enough" history, which is a call the user is better placed to make: the
  // span travels with the band, so a two-year window is visible as one and can
  // be weighed accordingly.
  const MIN_PAIRED_YEARS = 2
  if (ratios.length < 20 || pairedYears < MIN_PAIRED_YEARS) {
    return { insufficient: true, pairedYears, samples: ratios.length,
             earningsYears: epsByYear.size, priceDays: closes.length,
             // Name the fix, not the shortfall. "Only 4 years of reported
             // earnings" tells the user what is wrong without telling them what
             // to do — and the remedy is concrete: Yahoo returns four or five
             // annual periods, Screener carries ten or more, and pasting them
             // widens the band immediately.
             reason: epsByYear.size < MIN_PAIRED_YEARS + 1
               ? `${epsByYear.size} year${epsByYear.size === 1 ? '' : 's'} of earnings gives no range to measure — paste the Screener tables for a fuller history`
               : `prices and earnings overlap for ${pairedYears} year${pairedYears === 1 ? '' : 's'} — paste the Screener tables to extend it` }
  }

  ratios.sort((a, b) => a - b)
  const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]
  // Percentiles, not min/max: one panic day or one melt-up shouldn't define the
  // band the whole projection hangs off.
  return { low: round(q(0.15), 1), median: round(q(0.50), 1), high: round(q(0.85), 1),
           samples: ratios.length,
           // How many years the band actually spans, so a three-year window and
           // a nine-year one can be told apart downstream.
           spanYears: pairedYears }
}

/**
 * Historical P/B band, from actual dated prices and reported book value.
 *
 * Banks and NBFCs are valued on book and ROE, not on a margin applied to
 * "revenue" — for a lender, revenue IS interest income and the margin chain
 * borrowed from a manufacturer's P&L doesn't describe the business. Running the
 * standard path on SBIN produced a target far below both fair value and analyst
 * consensus, and the outlier was the estimate.
 *
 * `getApplicableModels` already excludes P/E-style models for lenders in the
 * valuation layer; this brings the estimate into line.
 */
export function pbBand(priceHistory = [], balanceHistory = [], incomeHistory = [], opts = {}) {
  const { fyEndMonth = 3 } = opts
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (closes.length === 0) return null

  // Book per share by fiscal year. Share count comes from profit ÷ EPS, the
  // weighted average the company itself used for that year.
  const bpsByYear = new Map()
  for (const bRow of balanceHistory || []) {
    const y = yearOf(bRow)
    const eq = val(bRow?.totalEquity)
    if (y == null || !(eq > 0)) continue
    const iRow = (incomeHistory || []).find(r => yearOf(r) === y)
    const np = val(iRow?.netProfit), eps = val(iRow?.eps)
    const sharesThen = (np > 0 && eps > 0) ? np / eps : null
    if (sharesThen > 0) bpsByYear.set(y, eq / sharesThen)
  }
  if (bpsByYear.size === 0) return null

  const ratios = []
  for (const [y, bps] of bpsByYear) {
    if (!(bps > 0)) continue
    const end = Date.UTC(y, fyEndMonth, 0)
    const start = Date.UTC(y - 1, fyEndMonth, 1)
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      const pb = c.close / bps
      if (pb > 0.2 && pb < 12) ratios.push(pb)
    }
  }
  if (ratios.length < 20) return null

  ratios.sort((a, b) => a - b)
  const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]
  return { low: round(q(0.15), 2), median: round(q(0.50), 2), high: round(q(0.85), 2),
           samples: ratios.length }
}

/**
 * Lender estimate: grow book value by retained earnings, apply the P/B the
 * market has actually paid.
 *
 *   book per share × (1 + ROE × retention)  → next year's book
 *   × observed P/B band                     → price range
 *
 * Retention rather than the revenue growth rate, because a bank's book compounds
 * at the profit it keeps — that IS the growth mechanism, not an assumption
 * layered on top of one.
 */
export function buildLenderEstimate(ratioResult, opts = {}) {
  const { priceHistory = [], incomeHistory = [], balanceHistory = [], years = 1,
          multipleOverride = null, growthOverride = null } = opts
  const price = ratioResult?.price
  const bps = ratioResult?.ratios?.bookPerShare?.value ?? ratioResult?.bookPerShare
  const roe = ratioResult?.ratios?.roe?.value
  const payout = ratioResult?.ratios?.dividendPayout?.value
  if (!(bps > 0)) return null

  // Retention from the payout actually reported. Where the latest year is
  // missing it, the company's own historical average payout is used — the
  // flat 80% it used to fall back to was a number I chose, and it fires on
  // exactly the companies whose data is thinnest.
  const histPayout = averagePayout(opts.incomeHistory)
  const payoutPct = (payout != null && payout >= 0 && payout <= 100) ? payout : histPayout
  if (payoutPct == null) return null           // no basis → no estimate
  const retention = 1 - payoutPct / 100
  const growth = growthOverride != null ? growthOverride
    : (roe > 0 ? (roe / 100) * retention : null)
  if (growth == null) return null

  const forwardBook = bps * Math.pow(1 + growth, years)

  const band = pbBand(priceHistory, balanceHistory,
    opts.reportedIncomeHistory?.length ? opts.reportedIncomeHistory : incomeHistory)
  const currentPb = ratioResult?.ratios?.pb?.value ?? (price > 0 ? price / bps : null)
  let multiples, multipleBasis, multipleLabel
  if (multipleOverride > 0) {
    const spread = band && band.median > 0
      ? { lo: band.low / band.median, hi: band.high / band.median }
      : { lo: 0.75, hi: 1.25 }
    multiples = { low: round(multipleOverride * spread.lo, 2), base: round(multipleOverride, 2),
                  high: round(multipleOverride * spread.hi, 2) }
    multipleBasis = 'revision'; multipleLabel = `your re-rating (${round(multipleOverride, 2)}× book)`
  } else if (band) {
    multiples = { low: band.low, base: band.median, high: band.high }
    multipleBasis = 'observed'
    multipleLabel = `its own P/B range (${band.samples} days)`
  } else if (currentPb > 0) {
    multiples = { low: round(currentPb * 0.75, 2), base: round(currentPb, 2), high: round(currentPb * 1.25, 2) }
    multipleBasis = 'current'; multipleLabel = "today's P/B ±25% (no usable price history)"
  } else return null

  const target = {
    low:  round(forwardBook * multiples.low),
    base: round(forwardBook * multiples.base),
    high: round(forwardBook * multiples.high),
  }
  const upside = price > 0 ? {
    low:  round(((target.low  - price) / price) * 100, 1),
    base: round(((target.base - price) / price) * 100, 1),
    high: round(((target.high - price) / price) * 100, 1),
  } : null

  const degraded = []
  if (multipleBasis !== 'observed' && multipleBasis !== 'revision')
    degraded.push(`Multiple from ${multipleLabel}`)
  if (payout == null && histPayout != null)
    degraded.push(`Payout from the ${round(histPayout, 0)}% average this company has paid, not the latest year`)

  return {
    ok: true, model: 'lender',
    createdAt: Date.now(), horizonYears: years,
    priceAtEstimate: round(price),
    bookPerShare: round(bps), forwardBook: round(forwardBook),
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'roe-retention',
    growthLabel: growthOverride != null ? (opts.overrideLabel || 'an applied revision')
      : `${round(roe, 1)}% ROE × ${round(retention * 100, 0)}% retained`,
    marginPct: null, marginLabel: 'not applicable to a lender', marginSource: 'n/a',
    dilutionPct: 0, dilutionLabel: 'book already net of issuance',
    multiples, multipleBasis, multipleLabel,
    target, upside, degraded,
    epsPath: 'book × (ROE × retention) × P/B',
    basisSummary: `Book compounding at ${round(growth * 100, 1)}% (${round(roe, 1)}% ROE × ${round(retention * 100, 0)}% retained) · Multiple: ${multipleLabel}`,
  }
}

/**
 * Compound growth of any reported series, across every year available.
 *
 * Returns null rather than a number when the history won't support one — every
 * caller then declines to produce an estimate, which is the honest outcome. A
 * default here would be a figure of mine wearing the company's clothes.
 */
/**
 * CAGR over an explicit number of years, from the end of the series backwards.
 *
 * The window is a preference the user sets, so it has to be a real year count
 * rather than a label like "long run" — which means eight years on one stock and
 * twelve on another, and shifts as data arrives. Where the requested window
 * exceeds the history, everything available is used and the ACTUAL span is
 * returned, so the caller can say "you asked for 10 years, this stock has 6"
 * instead of labelling a 6-year figure as a 10-year one.
 */
export function windowedCagr(history = [], years, field = 'revenue') {
  const pts = (history || [])
    .map(r => ({ y: yearOf(r), v: val(r?.[field]) }))
    .filter(p => p.y != null && p.v > 0)
    .sort((a, b) => a.y - b.y)
  if (pts.length < 2) return null

  const span = Math.min(years, pts.length - 1)
  if (span < 1) return null
  const start = pts[pts.length - 1 - span]
  const end = pts[pts.length - 1]
  if (!(start.v > 0) || !(end.v > 0)) return null

  const growth = Math.pow(end.v / start.v, 1 / span) - 1
  if (!isFinite(growth) || growth > 0.6 || growth < -0.3) return null

  return {
    growth,
    years: span,                       // what was ACTUALLY used
    requested: years,
    truncated: span < years,
    from: start.y, to: end.y,
    label: span === years
      ? `${span}-yr revenue CAGR`
      : `${span}-yr revenue CAGR (asked for ${years}, history has ${pts.length})`,
  }
}

export function seriesCagr(history = [], field = 'revenue', label = null) {
  const vals = (history || [])
    .map(r => ({ year: yearOf(r), v: val(r?.[field]) }))
    .filter(r => r.year != null && r.v > 0)
    .sort((a, b) => a.year - b.year)
  if (vals.length < 3) return null            // two points is a line, not a trend

  const first = vals[0], last = vals[vals.length - 1]
  const years = last.year - first.year
  if (years < 2) return null
  const growth = Math.pow(last.v / first.v, 1 / years) - 1
  if (!isFinite(growth)) return null

  // A CAGR outside this band is a recovery from a collapsed base or a one-off,
  // not a rate to project forward.
  if (growth > 0.6 || growth < -0.3) return null

  return { growth, label: label || `${field} CAGR`, years, from: first.year, to: last.year }
}

/**
 * How widely this stock's own multiple has ranged, as a proportion of its
 * median. Used for the width of an estimate range so a steadily-rated business
 * gets a narrow one and a volatile business a wide one — a fixed percentage
 * says the same thing about every company, which is never true.
 */
export function multipleSpread(priceHistory = [], incomeHistory = [], field = 'eps') {
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
  if (closes.length < 100) return null

  const ratios = []
  for (const row of incomeHistory || []) {
    const y = yearOf(row)
    const denom = val(row?.[field])
    if (y == null || !(denom > 0)) continue
    const start = Date.UTC(y - 1, 3, 1), end = Date.UTC(y, 3, 0)
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      ratios.push(c.close / denom)
    }
  }
  if (ratios.length < 60) return null

  ratios.sort((a, b) => a - b)
  const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]
  const median = q(0.5)
  if (!(median > 0)) return null
  const lo = q(0.15) / median, hi = q(0.85) / median
  // A degenerate spread (all observations identical) would collapse the range.
  if (!(lo > 0.3) || !(hi < 3) || hi <= lo) return null
  return { lo, hi, samples: ratios.length }
}

export function revenueCagr(history = [], { label } = {}) {
  const r = seriesCagr(history, 'revenue', label)
  if (r) return { ...r, label: `${r.label} (${r.from}–${r.to})` }
  return null
}

/** Average dividend payout the company has actually paid. */
export function averagePayout(history = []) {
  const rates = []
  for (const row of history || []) {
    const np = val(row?.netProfit)
    const div = val(row?.dividendPaid) ?? val(row?.dividend)
    if (np > 0 && div >= 0) {
      const pct = (div / np) * 100
      if (pct >= 0 && pct <= 100) rates.push(pct)
    }
  }
  if (rates.length === 0) return null
  rates.sort((a, b) => a - b)
  return rates[Math.floor(rates.length / 2)]
}

/**
 * CYCLICAL — normalised earnings, not this year's.
 *
 * A commodity business earns what the commodity price allows, and the latest
 * year records where the cycle is rather than what the business earns through
 * one. Applying a through-cycle multiple to peak earnings double-counts the
 * peak; at a trough it double-counts the trough. The standard correction is to
 * apply a mid-cycle MARGIN to current revenue — revenue is far less
 * cycle-sensitive than margin, so this keeps the company's actual scale while
 * removing the swing.
 */
export function buildCyclicalEstimate(ratioResult, opts = {}) {
  const { incomeHistory = [], priceHistory = [], balanceHistory = [], years = 1,
          multipleOverride = null, growthOverride = null, peerBand = null } = opts
  const price = ratioResult?.price
  const revenue = ratioResult?.revenue
  const eps = ratioResult?.eps
  const netProfit = ratioResult?.netProfit
  if (!(revenue > 0) || !(eps > 0) || !(netProfit > 0)) return null

  // Mid-cycle margin: the median across every year available, which spans more
  // of a cycle than any average of the last two or three.
  const margins = []
  for (const row of incomeHistory) {
    const rev = val(row?.revenue), np = val(row?.netProfit)
    if (rev > 0 && np != null) margins.push(np / rev)
  }
  if (margins.length < 4) return null          // too short to contain a cycle
  const sorted = [...margins].sort((a, b) => a - b)
  const midCycleMargin = sorted[Math.floor(sorted.length / 2)]
  const currentMargin = netProfit / revenue
  if (!(midCycleMargin > 0)) return null

  const shares = netProfit / eps

  // Revenue growth from this company's OWN record, not a default. A fixed 6%
  // was firing for every commodity company regardless of history — the number
  // was mine, not the business's. Measured across the full span available,
  // because a commodity company's recent growth is a cycle position too.
  const growthInfo = growthOverride != null
    ? { growth: growthOverride, label: (opts.overrideLabel || 'an applied revision') }
    : revenueCagr(incomeHistory, { label: 'revenue CAGR over the cycle' })
  if (growthInfo?.growth == null) return null      // no history → no estimate
  const growth = growthInfo.growth
  const projRevenue = revenue * Math.pow(1 + growth, years)
  const normalisedProfit = projRevenue * midCycleMargin
  const normalisedEps = normalisedProfit / shares

  // The multiple is applied to NORMALISED earnings, so it must be a
  // through-cycle multiple too — the median of what the market paid across the
  // same span, not today's.
  const bandHistory = opts.reportedIncomeHistory?.length ? opts.reportedIncomeHistory : incomeHistory
  const bandRaw = forwardPeBand(priceHistory, bandHistory)
  const band = bandRaw?.insufficient ? null : bandRaw
  let multiples, multipleBasis, multipleLabel
  if (multipleOverride > 0) {
    multiples = { low: multipleOverride * 0.85, base: multipleOverride, high: multipleOverride * 1.15 }
    multipleBasis = 'revision'; multipleLabel = `your re-rating (${round(multipleOverride, 1)}×)`
  } else if (band) {
    multiples = { low: band.low, base: band.median, high: band.high }
    multipleBasis = 'observed'; multipleLabel = `through-cycle P/E (${band.samples} days)`
  } else if (peerBand?.median > 0) {
    multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
    multipleBasis = 'peer'; multipleLabel = 'peer multiples'
  } else return null

  // A band is only usable if it is actually a band: low < base < high, spanning
  // a sensible width. The real failure mode here isn't width — it's a DEGENERATE
  // band, where two of the three percentiles collapse onto the same value
  // because the sample was too thin or the prices too flat. That renders as
  // "69.85 – 69.85 – 201.94", which looks like a range and isn't one.
  const degenerate = !(multiples.base > 0)
    || multiples.low >= multiples.base
    || multiples.high <= multiples.base
  if (degenerate) return null
  const target = {
    low:  round(normalisedEps * multiples.low),
    base: round(normalisedEps * multiples.base),
    high: round(normalisedEps * multiples.high),
  }
  const upside = price > 0 ? {
    low:  round(((target.low - price) / price) * 100, 1),
    base: round(((target.base - price) / price) * 100, 1),
    high: round(((target.high - price) / price) * 100, 1),
  } : null

  const cyclePosition = currentMargin > midCycleMargin * 1.25 ? 'above mid-cycle'
    : currentMargin < midCycleMargin * 0.75 ? 'below mid-cycle' : 'near mid-cycle'

  return {
    ok: true, model: 'cyclical',
    createdAt: Date.now(), horizonYears: years,
    priceAtEstimate: round(price),
    eps: round(eps), forwardEps: round(normalisedEps),
    epsPath: 'revenue × mid-cycle margin ÷ shares',
    marginPct: round(midCycleMargin * 100, 1),
    marginLabel: `mid-cycle margin (median of ${margins.length} years)`,
    marginSource: 'normalised',
    currentMarginPct: round(currentMargin * 100, 1),
    cyclePosition,
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'cagr',
    growthLabel: `${growthInfo.label} — margin normalised separately`,
    dilutionPct: 0, dilutionLabel: 'not modelled for a cyclical',
    multiples, multipleBasis, multipleLabel,
    target, upside,
    degraded: [],
    basisSummary: `Mid-cycle margin ${round(midCycleMargin * 100, 1)}% (currently ${round(currentMargin * 100, 1)}%, ${cyclePosition}) · ${multipleLabel}`,
  }
}

/**
 * CAPITAL-INTENSIVE — EV/EBITDA.
 *
 * Telecom, airports, toll roads: depreciation on a huge asset base swamps net
 * profit, so net margin describes the accounting rather than the business, and
 * P/E on a near-zero or negative EPS is meaningless. EBITDA before that
 * depreciation is what these are actually valued on, and enterprise value is the
 * matching numerator because the debt funding those assets is part of the price.
 */
export function buildEvEbitdaEstimate(ratioResult, opts = {}) {
  const { years = 1, multipleOverride = null, growthOverride = null, peerBand = null } = opts
  const price = ratioResult?.price
  const ebitda = ratioResult?.ebitda ?? ratioResult?.ratios?.ebitda?.value
  const ev = ratioResult?.ev ?? ratioResult?.ratios?.ev?.value
  const netDebt = (ratioResult?.totalDebt ?? 0) - (ratioResult?.cash ?? 0)
  const eps = ratioResult?.eps
  const netProfit = ratioResult?.netProfit
  const shares = (netProfit > 0 && eps > 0) ? netProfit / eps : ratioResult?.shares
  if (!(ebitda > 0) || !(shares > 0) || !(price > 0)) return null

  const currentEvEbitda = ev > 0 ? ev / ebitda : null

  // EBITDA growth measured from reported EBITDA where the history carries it,
  // falling back to revenue growth — for a capital-intensive business with a
  // stable cost base the two track closely, and that substitution is stated
  // rather than silent. No default: without either, there is no estimate.
  const growthInfo = growthOverride != null
    ? { growth: growthOverride, label: (opts.overrideLabel || 'an applied revision') }
    : (seriesCagr(opts.incomeHistory, 'ebitda', 'EBITDA CAGR')
       ?? revenueCagr(opts.incomeHistory, { label: 'revenue CAGR (EBITDA history unavailable)' }))
  if (growthInfo?.growth == null) return null
  const growth = growthInfo.growth
  const forwardEbitda = ebitda * Math.pow(1 + growth, years)

  let multiple, multipleBasis, multipleLabel
  if (multipleOverride > 0) {
    multiple = multipleOverride
    multipleBasis = 'revision'; multipleLabel = `your re-rating (${round(multiple, 1)}× EBITDA)`
  } else if (currentEvEbitda > 0) {
    multiple = currentEvEbitda
    multipleBasis = 'current'; multipleLabel = `current EV/EBITDA (${round(currentEvEbitda, 1)}×)`
  } else if (peerBand?.median > 0) {
    multiple = peerBand.median
    multipleBasis = 'peer'; multipleLabel = 'peer EV/EBITDA'
  } else return null

  // EV → equity: subtract the net debt, because that part of the enterprise
  // belongs to lenders rather than shareholders.
  // Net debt moves too. Subtracting today's figure from a forward enterprise
  // value treats the company as generating no cash over the projection year —
  // the same error as freezing the payout in the two-stage model, and it
  // understates a debt-heavy business by roughly the free cash it retains.
  //
  // The retained share is approximated from EBITDA rather than assumed: what
  // survives tax, interest and maintenance capex, less anything paid out.
  const payoutFrac = (ratioResult?.ratios?.dividendPayout?.value ?? 0) / 100
  const retainedCash = ebitda * 0.35 * Math.max(0, 1 - payoutFrac) * years
  const forwardNetDebt = Math.max(0, netDebt - retainedCash)

  const toEquity = (m) => {
    const impliedEv = forwardEbitda * m
    return (impliedEv - forwardNetDebt) / shares
  }
  // Range width from how much this company's OWN multiple has actually varied,
  // not a fixed ±15%. A steadily-rated business gets a tight range and a
  // volatile one a wide range, which is the information a fixed spread erases.
  const sp = multipleSpread(opts.priceHistory, opts.incomeHistory, 'ebitda') || { lo: 0.85, hi: 1.15 }
  const target = {
    low:  round(toEquity(multiple * sp.lo)),
    base: round(toEquity(multiple)),
    high: round(toEquity(multiple * sp.hi)),
  }
  if (!(target.base > 0)) return null

  const upside = {
    low:  round(((target.low - price) / price) * 100, 1),
    base: round(((target.base - price) / price) * 100, 1),
    high: round(((target.high - price) / price) * 100, 1),
  }

  return {
    ok: true, model: 'ev-ebitda',
    createdAt: Date.now(), horizonYears: years,
    priceAtEstimate: round(price),
    ebitda: round(ebitda), forwardEbitda: round(forwardEbitda),
    netDebt: round(netDebt),
    forwardNetDebt: round(forwardNetDebt),
    epsPath: 'EBITDA × EV/EBITDA, less net debt after a year of cash generation, ÷ shares',
    marginPct: null, marginLabel: 'EBITDA-based — net margin not used', marginSource: 'n/a',
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'cagr',
    growthLabel: growthInfo.label,
    dilutionPct: 0, dilutionLabel: 'not modelled',
    multiples: { low: round(multiple * sp.lo, 1), base: round(multiple, 1), high: round(multiple * sp.hi, 1) },
    multipleBasis, multipleLabel,
    target, upside, degraded: [],
    basisSummary: `EBITDA ${round(forwardEbitda)} × ${round(multiple, 1)}× less net debt ${round(forwardNetDebt)} · ${multipleLabel}`,
  }
}

/**
 * LOSS-MAKING — EV/Sales.
 *
 * With no positive EPS every earnings-based method returns nothing, which is how
 * the app has been treating these: silence. Revenue still exists and the market
 * still prices it, so EV/Sales is the honest fallback — weak, and labelled as
 * weak, but a number with a stated basis beats no number at all.
 */
export function buildEvSalesEstimate(ratioResult, opts = {}) {
  const { years = 1, peerBand = null, multipleOverride = null, growthOverride = null } = opts
  const price = ratioResult?.price
  const revenue = ratioResult?.revenue
  const ev = ratioResult?.ev ?? ratioResult?.ratios?.ev?.value
  const netDebt = (ratioResult?.totalDebt ?? 0) - (ratioResult?.cash ?? 0)
  const marketCap = ratioResult?.marketCap
  const shares = marketCap > 0 && price > 0 ? marketCap / price : ratioResult?.shares
  if (!(revenue > 0) || !(shares > 0) || !(price > 0)) return null

  const currentEvSales = ev > 0 ? ev / revenue : null
  const multiple = multipleOverride > 0 ? multipleOverride
    : currentEvSales > 0 ? currentEvSales
    : peerBand?.median > 0 ? peerBand.median : null
  if (!(multiple > 0)) return null

  const growthInfo = growthOverride != null
    ? { growth: growthOverride, label: (opts.overrideLabel || 'an applied revision') }
    : revenueCagr(opts.incomeHistory, { label: 'revenue CAGR' })
  if (growthInfo?.growth == null) return null
  const growth = growthInfo.growth
  const forwardRevenue = revenue * Math.pow(1 + growth, years)
  // Same correction as EV/EBITDA — but a loss-making company BURNS cash rather
  // than repaying debt, so net debt grows over the year instead of shrinking.
  // Freezing it would flatter exactly the companies least able to afford it.
  const burn = netProfitOf(ratioResult) < 0 ? Math.abs(netProfitOf(ratioResult)) * years : 0
  const forwardNetDebt = netDebt + burn
  const toEquity = m => ((forwardRevenue * m) - forwardNetDebt) / shares

  const sp = multipleSpread(opts.priceHistory, opts.incomeHistory, 'revenue') || { lo: 0.75, hi: 1.25 }
  const target = {
    low:  round(toEquity(multiple * sp.lo)),
    base: round(toEquity(multiple)),
    high: round(toEquity(multiple * sp.hi)),
  }
  if (!(target.base > 0)) return null

  return {
    ok: true, model: 'ev-sales',
    createdAt: Date.now(), horizonYears: years,
    priceAtEstimate: round(price),
    epsPath: 'revenue × EV/Sales, less net debt, ÷ shares',
    marginPct: null, marginLabel: 'no profit to apply a margin to', marginSource: 'n/a',
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'cagr',
    growthLabel: growthInfo.label,
    dilutionPct: 0, dilutionLabel: 'not modelled',
    multiples: { low: round(multiple * sp.lo, 2), base: round(multiple, 2), high: round(multiple * sp.hi, 2) },
    multipleBasis: multipleOverride > 0 ? 'revision' : currentEvSales > 0 ? 'current' : 'peer',
    multipleLabel: `EV/Sales ${round(multiple, 2)}×`,
    target,
    upside: {
      low:  round(((target.low - price) / price) * 100, 1),
      base: round(((target.base - price) / price) * 100, 1),
      high: round(((target.high - price) / price) * 100, 1),
    },
    // Stated rather than implied: this is the weakest method here, used because
    // the company has no earnings to value.
    degraded: ['No profit — valued on sales, which ignores whether they convert to cash'],
    basisSummary: `Revenue ${round(forwardRevenue)} × ${round(multiple, 2)}× sales, less net debt`,
  }
}

const netProfitOf = rr => (rr?.netProfit ?? 0)

/** Growth ladder: guidance → 5y CAGR → recent median → any CAGR → nothing. */
/**
 * Growth for the projection: which rate is applied, and what the alternatives
 * said.
 *
 * A ladder that returns on the first match discards everything below it, so the
 * app could never report that the applied rate disagreed with the others. Every
 * available basis is computed; precedence decides which one is USED, and the
 * rest are returned as `alternatives` so the spread can be shown.
 */
export function resolveGrowthBasis(ratioResult, opts = {}) {
  const { guidedGrowth = null, guidanceFiscalYear = null, guidanceExpired = false,
          overrideLabel = null } = opts
  const r = ratioResult?.ratios || {}
  const all = []

  // 1. Guidance, if entered. (An applied revision outranks this and is handled by
  //    the caller via growthOverride, so it never reaches here.)
  if (guidedGrowth != null && isFinite(guidedGrowth)) {
    all.push({ growth: guidedGrowth, source: 'guidance', rung: 'best',
               label: overrideLabel || `guidance${guidanceFiscalYear ? ` (${guidanceFiscalYear})` : ''}` })
  }
  // 2. The single dynamic CAGR — identical to every other consumer.
  if (r.revCagr?.value != null && isFinite(r.revCagr.value)) {
    all.push({ growth: r.revCagr.value / 100, source: 'cagr', rung: 'fallback',
               label: r.revCagrWindowYears?.value
                ? `${r.revCagrWindowYears.value}-yr revenue CAGR (your window)`
                  : 'revenue CAGR (your window)' })
  }

  if (all.length === 0) {
    return { growth: null, source: 'none', rung: 'none', label: 'no growth basis', alternatives: [] }
  }
  const chosen = all[0]
  const alternatives = all.slice(1)
  let spreadPts = null
  if (all.length > 1) {
    const vals = all.map(a => a.growth * 100)
    spreadPts = round(Math.max(...vals) - Math.min(...vals), 1)
  }
  return { ...chosen, alternatives, spreadPts, expiredGuidance: guidanceExpired }
}

/**
 * Margin ladder: guided → 3-yr average → last reported.
 *
 * The first version skipped this and grew EPS by the REVENUE growth rate, which
 * silently assumes margins never move. They do — and a company quietly losing
 * margin for three years projected as if it weren't. The average is the default
 * rather than last year's because one year can be distorted by a one-off, and
 * the whole projection hangs off this number.
 */
export function resolveMarginBasis(incomeHistory = [], opts = {}) {
  const { guidedMargin = null } = opts
  if (guidedMargin != null && isFinite(guidedMargin)) {
    return { margin: guidedMargin, source: 'guidance', rung: 'best', label: 'guided margin' }
  }
  const margins = []
  for (const row of incomeHistory || []) {
    const rev = val(row?.revenue), np = val(row?.netProfit)
    if (rev > 0 && np != null) margins.push(np / rev)
  }
  if (margins.length === 0) {
    return { margin: null, source: 'none', rung: 'none', label: 'no margin history' }
  }
  const recent = margins.slice(-3)
  if (recent.length >= 3) {
    const avg = recent.reduce((s, m) => s + m, 0) / recent.length
    // Trend is reported alongside so the UI can say "and it's been falling"
    // without the projection silently extrapolating a trend line of its own.
    const trend = recent[recent.length - 1] - recent[0]
    return { margin: avg, source: 'average', rung: 'good', label: '3-yr average margin',
             trendPct: round(trend * 100, 1) }
  }
  return { margin: margins[margins.length - 1], source: 'last', rung: 'fallback',
           label: 'last reported margin' }
}

/**
 * Dilution ladder: observed share-count growth → flat.
 * EPS is profit ÷ shares, and share counts drift up (ESOPs, QIPs). A frozen
 * count overstates EPS for anyone funding growth with equity — lenders
 * especially, since growing the book needs capital.
 */
export function resolveDilution(incomeHistory = []) {
  // Derived as profit ÷ EPS rather than read off a share-count field: normalize
  // stores no per-year share count on balanceHistory (BALANCE_F has no such
  // field), so an earlier loop reading row.shares there could never fire.
  // Profit ÷ EPS is the weighted average count the company itself used for that
  // year's EPS, which is the right basis for a dilution rate anyway.
  const counts = []
  for (const row of (incomeHistory || [])) {
    const np = val(row?.netProfit), eps = val(row?.eps)
    if (np > 0 && eps > 0) counts.push(np / eps)
  }
  if (counts.length < 2) {
    return { rate: 0, source: 'assumed-flat', rung: 'fallback', label: 'no share-count history' }
  }
  // Year-on-year changes, so a single discrete event can be identified and
  // removed rather than being smeared across the whole span by a CAGR.
  const steps = []
  for (let i = 1; i < counts.length; i++) {
    if (counts[i - 1] > 0 && counts[i] > 0) steps.push(counts[i] / counts[i - 1] - 1)
  }
  if (steps.length === 0) {
    return { rate: 0, source: 'assumed-flat', rung: 'fallback', label: 'no share-count history' }
  }

  const sorted = [...steps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const scale = Math.max(Math.abs(median), 0.01)      // a floor, so a flat history still has a scale
  const ordinary = steps.filter(x => Math.abs(x) <= scale * ONE_OFF_MULTIPLE)
  const excluded = steps.length - ordinary.length

  const used = ordinary.length > 0 ? ordinary : steps
  const rate = Math.max(0, used.reduce((t, x) => t + x, 0) / used.length)

  return {
    rate, source: 'observed', rung: 'good',
    excludedYears: excluded,
    label: rate > 0.001
      ? `${round(rate * 100, 1)}%/yr dilution` +
        (excluded > 0 ? ` (${excluded} one-off issuance${excluded > 1 ? 's' : ''} excluded)` : '')
      : 'no material dilution',
  }
}

/**
 * Sanity check, lenders especially: growth needs capital. A business can only
 * self-fund g ≈ ROE × retention. Guiding well above that isn't impossible — it
 * means raising equity or leverage — but it should be SAID rather than absorbed
 * silently into a price target.
 */
export function financeabilityNote(ratioResult, growth) {
  const roe = ratioResult?.ratios?.roe?.value
  if (roe == null || growth == null) return null
  const payout = ratioResult?.ratios?.dividendPayout?.value
  const retention = (payout != null && payout >= 0 && payout <= 100) ? 1 - payout / 100 : 1
  const sustainable = (roe / 100) * retention
  if (!(sustainable > 0)) return null
  if (growth <= sustainable * 1.15) return null      // comfortably financeable
  return {
    sustainablePct: round(sustainable * 100, 1),
    growthPct: round(growth * 100, 1),
    note: `${round(growth * 100, 1)}% growth is more than ${round(roe, 1)}% ROE can self-fund `
        + `(~${round(sustainable * 100, 1)}%) — it implies raising capital or more leverage.`,
  }
}

/**
 * Build the estimate.
 *
 * @param opts.guidedGrowth  decimal (0.18) — guidance or ScoringStudio
 * @param opts.guidedMargin  decimal (0.22) — margin guidance, when given
 * @param opts.years         horizon (default 1: a near-term claim is checkable
 *                           within a year; a 5-year one can't be corrected until
 *                           it's far too late to matter)
 * @param opts.peerBand      { low, median, high } — optional second multiple
 *                           anchor; own history is blind to a sector re-rating
 */
/**
 * JUSTIFIED MULTIPLES — a second fair value, not a projection.
 *
 * `payout / (r - g)` is a present-value formula: it says what a stream of
 * earnings is worth TODAY. Multiplying its output by next year's earnings, as an
 * earlier version did, mixes a valuation multiple with a projected base and
 * produces neither one thing nor the other.
 *
 * So this applies the justified multiple to CURRENT earnings and stands beside
 * the app's fair value — the same question answered a different way, which is
 * what makes the comparison worth having. Growth still enters, but through the
 * multiple where it belongs: a faster-growing company earns a higher one.
 *
 * Needs no price history, which is why it holds where the market-based estimate
 * cannot.
 */
export function buildJustifiedEstimate(ratioResult, opts = {}) {
  const { sectorType, form: forcedForm = null, years = 1 } = opts
  const jm = justifiedMultiples(ratioResult, opts)
  if (!jm.available) {
    return { ok: false, model: 'justified', missing: jm.missing,
             note: `Can't derive a justified multiple — missing ${jm.missing.join(', ')}.` }
  }

  const form = (forcedForm && jm.forms[forcedForm]) ? forcedForm
    : preferredForm(sectorType, jm.forms, ratioResult)
  const chosen = jm.forms[form]
  // A justified multiple in the hundreds means growth has converged on the
  // required return and the formula is dividing by almost nothing. That is the
  // model failing, not a valuation.
  const CEILING = { pe: 60, pb: 12, evEbitda: 30, evSales: 15 }
  if (chosen && chosen.multiple > (CEILING[form] ?? 60)) {
    return { ok: false, model: 'justified',
             note: `Growth (${jm.growth.gPct}%) is too close to the required return ` +
                   `(${round(jm.requiredReturn.r * 100, 1)}%) for a stable ${FORM_NAMES[form]} — ` +
                   `the formula becomes unbounded here.` }
  }
  if (!chosen) {
    return { ok: false, model: 'justified', missing: jm.missing,
             note: 'No justified multiple applies to this business.' }
  }

  const price = ratioResult?.price
  const R = ratioResult?.ratios || {}
  const g = jm.growth.g

  // The quantity the multiple attaches to, projected one year.
  let base, baseLabel
  switch (form) {
    case 'pe':       base = ratioResult?.eps; baseLabel = 'EPS'; break
    case 'pb':       base = R.bookPerShare?.value; baseLabel = 'book per share'; break
    case 'evEbitda': base = ratioResult?.ebitda ?? R.ebitda?.value; baseLabel = 'EBITDA'; break
    case 'evSales':  base = ratioResult?.revenue; baseLabel = 'revenue'; break
    default: base = null
  }
  if (!(base > 0)) {
    return { ok: false, model: 'justified',
             note: `No ${baseLabel || 'basis'} to apply a ${FORM_NAMES[form]} multiple to.` }
  }
  // CURRENT base, not projected. The multiple already embeds the growth
  // expectation; projecting the base as well would count it twice.
  const forward = base

  // EV forms price the whole enterprise, so debt has to come out to reach a
  // per-share equity value.
  const isEv = form === 'evEbitda' || form === 'evSales'
  const netDebt = (ratioResult?.totalDebt ?? 0) - (ratioResult?.cash ?? 0)
  const shares = (ratioResult?.netProfit > 0 && ratioResult?.eps > 0)
    ? ratioResult.netProfit / ratioResult.eps : ratioResult?.shares
  if (isEv && !(shares > 0)) {
    return { ok: false, model: 'justified', note: 'No share count to convert enterprise value per share.' }
  }

  const toPrice = (m) => isEv ? ((forward * m) - netDebt) / shares : forward * m
  const mid = toPrice(chosen.multiple)
  if (!(mid > 0)) {
    return { ok: false, model: 'justified',
             note: 'The justified multiple produces a negative value — debt exceeds what the business supports.' }
  }

  // Range from the sensitivity of the formula to the required return — the one
  // input carrying real uncertainty. A higher required return gives a lower
  // multiple, so +1 point produces the LOW end.
  //
  // The formula becomes explosive as r approaches g (the denominator tends to
  // zero), which is exactly where a ±1 point move produces a meaningless
  // number: a TCS-like case gave a base of 529× and a "high" below its "low".
  // So the perturbed values are used only when they stay within a sane multiple
  // of the base, and the band is sorted rather than assumed to be ordered.
  const rr = jm.requiredReturn
  const alt = (dr) => {
    const j2 = justifiedMultiples(ratioResult, { ...opts, riskFreeRate: rr.riskFreeRate + dr })
    const m2 = j2.forms?.[form]?.multiple
    if (!(m2 > 0)) return null
    const ratio = m2 / chosen.multiple
    return (ratio > 0.4 && ratio < 2.5) ? m2 : null    // beyond this the formula has gone unstable
  }
  const mHigher = alt(-0.01)   // lower required return -> higher multiple
  const mLower  = alt(+0.01)   // higher required return -> lower multiple

  const ends = [
    mLower  != null ? toPrice(mLower)  : mid * 0.85,
    mHigher != null ? toPrice(mHigher) : mid * 1.15,
  ].filter(x => x > 0).sort((a, b) => a - b)

  const target = {
    low:  round(ends[0] ?? mid * 0.85),
    base: round(mid),
    high: round(ends[ends.length - 1] ?? mid * 1.15),
  }
  // A base outside its own band means the perturbation was unusable; fall back
  // to a proportional band around the base rather than shipping an inverted one.
  if (target.low > target.base || target.high < target.base) {
    target.low = round(mid * 0.85)
    target.high = round(mid * 1.15)
  }

  return {
    ok: true, model: 'justified', form,
    kind: 'valuation',              // not a projection — no horizon
    createdAt: Date.now(),
    priceAtEstimate: round(price),
    multiples: { low: round(mLower ?? chosen.multiple * 0.85, 2), base: chosen.multiple,
                 high: round(mHigher ?? chosen.multiple * 1.15, 2) },
    multipleBasis: 'justified',
    multipleLabel: chosen.label,
    multipleSteps: chosen.steps,
    availableForms: Object.keys(jm.forms),
    formLabels: Object.fromEntries(Object.entries(jm.forms).map(([k, f]) => [k, f.label])),
    growth: g, growthPct: jm.growth.gPct,
    growthSource: 'roe-retention',
    growthLabel: `${round(jm.growth.roe, 1)}% ROE × ${round(jm.growth.retention * 100, 0)}% retained`,
    requiredReturnPct: round(rr.r * 100, 1),
    requiredReturnLabel: rr.label,
    twoStage: jm.twoStage,
    base: round(base), baseLabel,
    target,
    upside: price > 0 ? {
      low:  round(((target.low - price) / price) * 100, 1),
      base: round(((target.base - price) / price) * 100, 1),
      high: round(((target.high - price) / price) * 100, 1),
    } : null,
    degraded: rr.betaAssumed ? ['Beta unavailable — assumed 1.0'] : [],
    missing: jm.missing,
    basisSummary: `${chosen.label} ${chosen.multiple}× on ${baseLabel} · ${rr.label}`,
  }
}

const FORM_NAMES = { pe: 'P/E', pb: 'P/B', evEbitda: 'EV/EBITDA', evSales: 'EV/Sales' }

export function buildEstimate(ratioResult, opts = {}) {
  const {
    guidedGrowth = null, guidedMargin = null, guidanceFiscalYear = null,
    guidanceExpired = false, growthOverride = null, marginOverride = null,
    multipleOverride = null,
    priceHistory = [], incomeHistory = [], balanceHistory = [],
    peerBand = null, years = 1,
  } = opts

  // Lenders take the book-and-ROE path. The margin chain below describes a
  // manufacturer's P&L and produces a badly low number for a bank, whose
  // "revenue" is interest income.
  // ── Method selection ──────────────────────────────────────────────────────
  // The sector-appropriate method is PREFERRED; the revenue-margin-P/E chain
  // below is the fallback when the preferred one can't be computed (too little
  // history, a missing input). Choosing the method is the first decision in a
  // valuation, not an afterthought — running one model over every business is
  // what produced a target five times the price for LIC and half fair value for
  // SBIN.
  //
  // Each returns null rather than a wrong number when its inputs are absent, so
  // falling through is always to a weaker method, never to a broken one.
  const st = opts.sectorType

  if (st === 'bank' || st === 'nbfc' || st === 'insurance' || st === 'financial') {
    const lender = buildLenderEstimate(ratioResult, opts)
    if (lender) return lender
  }

  if (st === 'cyclical') {
    const cyc = buildCyclicalEstimate(ratioResult, opts)
    if (cyc) return cyc
  }

  if (st === 'capital-intensive' || st === 'yield') {
    const ev = buildEvEbitdaEstimate(ratioResult, opts)
    if (ev) return ev
  }

  // Realty and holding companies need NAV or stake data the app doesn't hold.
  // Rather than produce a number from a method that doesn't apply, they get the
  // standard chain WITH the mismatch stated — an estimate carrying its own
  // caveat is more useful than either silence or false confidence.
  const methodCaveat = (st === 'realty')
    ? 'Real estate is normally valued on the net asset value of the land bank; this is an earnings-based approximation.'
    : (st === 'holding')
    ? 'A holding company is normally valued as the sum of its stakes less a discount; this is an earnings-based approximation.'
    : null

  // No positive earnings — every method above needs them, so sales is what's
  // left. Previously this returned nothing at all.
  if (!(ratioResult?.eps > 0)) {
    const sales = buildEvSalesEstimate(ratioResult, opts)
    if (sales) return methodCaveat
      ? { ...sales, degraded: [...sales.degraded, methodCaveat] } : sales
  }

  const degradedExtra = []
  const price     = ratioResult?.price
  const eps       = ratioResult?.eps
  const revenue   = ratioResult?.revenue
  const netProfit = ratioResult?.netProfit
  const currentPe = ratioResult?.ratios?.pe?.value ?? (price && eps ? price / eps : null)

  if (!(eps > 0)) {
    return blank('No positive EPS — a multiple needs earnings to apply to.', { price })
  }

  // ── growth ────────────────────────────────────────────────────────────────
  const growthBasis = growthOverride != null
    ? { growth: growthOverride, source: 'revision', rung: 'best', label: (opts.overrideLabel || 'an applied revision') }
    // The full opts, not a hand-picked three. A pinned growth window needs
    // incomeHistory to compute over, and passing a subset meant the window was
    // silently ignored — the estimate looked identical whichever one was chosen.
    : resolveGrowthBasis(ratioResult, {
        ...opts, guidedGrowth, guidanceFiscalYear, guidanceExpired })
  if (growthBasis.growth == null) {
    return blank('No guidance and no usable growth history — nothing to project from.', { price })
  }
  if (methodCaveat) degradedExtra.push(methodCaveat)

  // ── margin ────────────────────────────────────────────────────────────────
  const marginBasis = marginOverride != null
    ? { margin: marginOverride, source: 'revision', rung: 'best', label: (opts.overrideLabel || 'an applied revision') }
    : resolveMarginBasis(incomeHistory, { guidedMargin })

  // ── dilution ──────────────────────────────────────────────────────────────
  const dilution = resolveDilution(incomeHistory)

  // ── forward EPS ───────────────────────────────────────────────────────────
  // Preferred: revenue → margin → profit → per-share, which exposes the margin
  // as an input you can see and argue with. If revenue or margin isn't
  // available, fall back to compounding EPS directly — the old margins-frozen
  // behaviour — and flag it rather than passing it off as equivalent.
  const g   = growthBasis.growth
  const dil = Math.pow(1 + dilution.rate, years)
  let forwardEps = null, epsPath, projRevenue = null, projProfit = null

  if (revenue > 0 && marginBasis.margin != null) {
    const sharesNow = (netProfit > 0 && eps > 0) ? netProfit / eps : (ratioResult?.shares || null)
    if (sharesNow > 0) {
      projRevenue = revenue * Math.pow(1 + g, years)
      projProfit  = projRevenue * marginBasis.margin
      forwardEps  = projProfit / (sharesNow * dil)
      epsPath = 'revenue × margin ÷ shares'
    }
  }
  if (forwardEps == null || !(forwardEps > 0)) {
    forwardEps = (eps * Math.pow(1 + g, years)) / dil
    epsPath = 'EPS compounded (margins assumed flat)'
    projRevenue = null; projProfit = null
  }

  let fittedSteps = null

  // ── multiple ──────────────────────────────────────────────────────────────
  // A re-rating is the one thing in this chain nothing mechanical can detect.
  // Growth and margin changes eventually show up in reported numbers; a
  // permanent shift in what buyers will PAY does not — the observed band keeps
  // describing the old regime, so the estimate would go on calling a stock cheap
  // while it de-rated. Only a human reading the reason (a rule change, a lost
  // advantage) can say so, which is why this override outranks every measured
  // basis below it rather than being blended with them.
  // Fitted target multiple: the stock's own historical anchor, adjusted by a
  // premium or discount REGRESSED from its own record of how the market has
  // priced its returns and growth. This is what analysts do — the flat median
  // below gives a company earning materially better returns than its history
  // exactly its history's multiple, which is the step that was missing.
  const fitted = targetMultiple({
    basis: 'pe', priceHistory, incomeHistory, balanceHistory,
    // Today's ROE, used as the forward expectation. Defensible over a one-year
    // horizon — ROE is far stickier than earnings — but it IS an assumption of
    // no change, and it belongs in the working rather than buried here.
    forwardRoe: ratioResult?.ratios?.roe?.value ?? null,
    forwardGrowth: growthBasis.growth != null ? growthBasis.growth * 100 : null,
    peerBand,
  })

  // Reported series for the band; normalised for the projection. See the note
  // on forwardPeBand.
  const bandHistory = opts.reportedIncomeHistory?.length ? opts.reportedIncomeHistory : incomeHistory
  const ownRaw = forwardPeBand(priceHistory, bandHistory)
  const bandReason = ownRaw?.insufficient ? ownRaw.reason : null
  let own = ownRaw?.insufficient ? null : ownRaw

  // A measured band should bracket, or at least neighbour, the multiple the
  // stock trades at today. When it sits several times away, the band is not
  // describing the current business: a company whose EPS jumped between the
  // early years in the sample (a recent listing, a loss year, a demerger)
  // produces historic ratios that have no bearing on what a forward multiple
  // should be. LIC's band came out at 60-75x against a stock trading near 14x,
  // and multiplying forward EPS by that gave a target five times the price.
  //
  // Rejecting it falls through to peers, then to today's multiple widened —
  // both weaker bases, but weak and roughly right beats precise and absurd.
  if (own && currentPe > 0) {
    const ratio = own.median / currentPe
    if (ratio > 2.5 || ratio < 0.4) {
      console.info(`[estimate] discarding P/E band ${own.low}-${own.high}x — ` +
                   `current multiple is ${round(currentPe, 1)}x, so the history isn't comparable`)
      own = null
    }
  }

  let multiples, multipleBasis, multipleLabel
  if (multipleOverride != null && multipleOverride > 0) {
    const c = multipleOverride
    // Keep whatever spread the measured band had, so a re-rating moves the
    // CENTRE of the range without also pretending the future got more certain.
    const spread = own && own.median > 0
      ? { lo: own.low / own.median, hi: own.high / own.median }
      : (() => { const d = priceDispersion(priceHistory)
                 return d != null ? { lo: 1 - d, hi: 1 + d } : null })()
    multiples = { low: round(c * spread.lo, 1), base: round(c, 1), high: round(c * spread.hi, 1) }
    multipleBasis = 'revision'
    multipleLabel = `your re-rating (${round(c, 1)}×)`
  } else if (fitted && fitted.source === 'fitted') {
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'fitted'
    multipleLabel = `${fitted.anchor}× historical anchor, adjusted for returns and growth`
    fittedSteps = fitted.steps
  } else if (own) {
    multiples = { low: own.low, base: own.median, high: own.high }
    multipleBasis = 'observed'
    // Name the span, not just the sample count. A band from three years and one
    // from nine both looked identical as "its own forward P/E range"; the first
    // describes a recent regime and the second a genuine range.
    // The span is stated either way; the prompt appears while a longer history
    // is still available to fetch, without implying the shorter one is invalid.
    multipleLabel = `its own forward P/E over ${own.spanYears} year${own.spanYears === 1 ? '' : 's'}` +
      (own.spanYears < 5 ? ' — paste the Screener tables for a longer range' : '')
  } else if (fitted?.multiple > 0) {
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'historical-median'
    multipleLabel = `its own median multiple over ${fitted.observations} years`
    fittedSteps = fitted.steps
  } else if (peerBand?.median > 0) {
    multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
    multipleBasis = 'peer'
    multipleLabel = 'peer multiples (no usable history for this stock)'
  } else if (currentPe > 0) {
    const c = currentPe
    const sp = priceDispersion(priceHistory)
    if (sp == null) {
      return blank(
        'No price history for this stock, so there is no way to measure how wide a range should be. ' +
        'The fundamentals-based estimate does not need price history and is shown instead.',
        { price })
    }
    multiples = { low: round(c * (1 - sp), 1), base: round(c, 1),
                  high: round(c * (1 + sp), 1) }
    multipleBasis = 'current'
    // Label built from the width actually used, and it names where the width
    // came from — measured dispersion or the last-resort figure.
    // Name the ACTUAL cause. "No usable history" was reported on stocks with a
    // decade of prices, because the shortfall was in reported earnings.
    multipleLabel = `today's P/E ±${Math.round(sp * 100)}%, the range this stock's price has moved in` +
      (bandReason ? ` — ${bandReason}` : '')
  } else {
    return blank('No usable P/E — nothing to anchor a multiple on.', { price })
  }

  // A band has to actually be one, and has to be plausible. Two failures are
  // caught here, both of which produced estimates several times the traded
  // price:
  //
  //  DEGENERATE — the percentiles have collapsed onto each other, so the "range"
  //  is one number with noise beside it. The previous version WIDENED these from
  //  the price history, which multiplied an error built on too little data
  //  rather than removing it.
  //
  //  IMPLAUSIBLE — a high/low ratio beyond about 2.5× isn't a multiple range,
  //  it's two different regimes averaged together (a re-listing, a loss year, a
  //  collapse in earnings). Trent's 59–171× came out this way.
  //
  // Either way the band is discarded and the caller falls through to peers or to
  // today's multiple — weaker anchors, but ones that can't be absurd.
  // "Effectively equal" rather than strictly equal: a low of 79.99 against a
  // base of 80 passes a `>=` test while being the same number, and renders as a
  // range whose lower half is meaningless. Anything inside 3% counts as
  // collapsed.
  const degenerate = !(multiples.base > 0)
    || multiples.low >= multiples.base * 0.97
    || multiples.high <= multiples.base * 1.03
  const implausible = multiples.low > 0 && (multiples.high / multiples.low) > 2.5
  if (degenerate || implausible) {
    console.info(`[estimate] discarding band ${multiples.low}-${multiples.high}x — ` +
                 (degenerate ? 'percentiles collapsed' : 'spread too wide to be one regime'))
    if (currentPe > 0) {
      const c = currentPe
      const sp = priceDispersion(priceHistory)
      if (sp == null) {
        return blank(
          'Its multiple history is unusable and there is no price history to measure a range from. ' +
          'The fundamentals-based estimate covers this case.',
          { price })
      }
      multiples = { low: round(c * (1 - sp), 1), base: round(c, 1), high: round(c * (1 + sp), 1) }
      multipleBasis = 'current'
      multipleLabel = `today's P/E ±${Math.round(sp * 100)}% — its own history was too thin or too erratic to use`
    } else if (peerBand?.median > 0) {
      multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
      multipleBasis = 'peer'
      multipleLabel = 'peer multiples — its own history was unusable'
    } else {
      return blank('No usable multiple: this stock\'s own history is too thin and no peers are available.',
                   { price })
    }
  }

  const target = {
    low:  round(forwardEps * multiples.low),
    base: round(forwardEps * multiples.base),
    high: round(forwardEps * multiples.high),
  }
  const upside = price > 0 ? {
    low:  round(((target.low  - price) / price) * 100, 1),
    base: round(((target.base - price) / price) * 100, 1),
    high: round(((target.high - price) / price) * 100, 1),
  } : null

  // Which inputs are NOT on their best rung. The dashboard shows one small dot
  // when this is non-empty and nothing at all when it's empty — a warning that
  // shows constantly gets ignored, so silence has to be the normal state.
  const degraded = [...degradedExtra]
  if (growthBasis.rung !== 'best') degraded.push(`Growth from ${growthBasis.label}, not guidance`)
  if (marginBasis.rung === 'fallback' || marginBasis.rung === 'none')
    degraded.push(`Margin from ${marginBasis.label}`)
  if (multipleBasis !== 'observed' && multipleBasis !== 'revision')
    degraded.push(`Multiple from ${multipleLabel}`)
  if (epsPath.startsWith('EPS compounded')) degraded.push('Margins assumed flat')
  if (growthBasis.expiredGuidance) degraded.push('Your guidance has expired')

  return {
    ok: true,
    createdAt: Date.now(),
    horizonYears: years,
    priceAtEstimate: round(price),

    eps: round(eps),
    forwardEps: round(forwardEps),
    epsPath,
    projRevenue: round(projRevenue),
    projProfit: round(projProfit),

    growth: g,
    growthPct: round(g * 100, 1),
    growthSource: growthBasis.source,
    growthLabel: growthBasis.label,
    // What the bases that weren't applied said. Precedence picks one to use;
    // returning the rest is the only way a disagreement between them can be
    // seen — a ladder that stops at the first match hides it entirely.
    growthAlternatives: (growthBasis.alternatives || []).map(a => ({
      pct: round(a.growth * 100, 1), label: a.label })),
    growthSpreadPts: growthBasis.spreadPts ?? null,

    marginPct: marginBasis.margin != null ? round(marginBasis.margin * 100, 1) : null,
    marginSource: marginBasis.source,
    marginLabel: marginBasis.label,
    marginTrendPct: marginBasis.trendPct ?? null,

    dilutionPct: round(dilution.rate * 100, 1),
    dilutionLabel: dilution.label,

    multiples, multipleBasis, multipleLabel,
    multipleSteps: fittedSteps,        // the working behind the adjustment
    target, upside,

    financeability: financeabilityNote(ratioResult, g),
    degraded,                     // [] when everything is on its best basis
    basisSummary: `Growth: ${growthBasis.label} · Margin: ${marginBasis.label} · Multiple: ${multipleLabel}`,
  }
}

/**
 * Does this estimate survive contact with the other two opinions in the app?
 *
 * The point of a standing check rather than another sector special-case: every
 * failure so far (LIC at 5x price, SBIN at half) was a MODEL-CHOICE error, and
 * each was obvious the moment the number was set beside fair value and analyst
 * consensus. Waiting for a person to notice is not a control.
 *
 * A wide divergence does not mean the market is wrong. It means one of three
 * things is wrong, and the estimate is the one to suspect — it is the newest and
 * the least corroborated. This does not silently correct anything; it marks the
 * number as unreliable so it is read that way.
 *
 * @param estimate  from buildEstimate
 * @param context   { price, fairValue: {low,high}, analystTarget: {low,high} }
 */
export function sanityCheck(estimate, context = {}) {
  if (!estimate?.ok || !(estimate.target?.base > 0)) return null
  const mid = estimate.target.base
  const { price, fairValue, analystTarget } = context
  const issues = []

  // 1 — against the traded price. An estimate several times the price is a
  // modelling error far more often than a genuine multi-bagger call.
  if (price > 0) {
    const r = mid / price
    if (r > 3) issues.push({ severity: 'high', kind: 'price',
      note: `${round(r, 1)}× the traded price — a gap that size usually means the wrong model, not a mispricing.` })
    else if (r < 0.33) issues.push({ severity: 'high', kind: 'price',
      note: `${round(r, 2)}× the traded price — the estimate is far below where the stock actually trades.` })
    else if (r > 2 || r < 0.5) issues.push({ severity: 'medium', kind: 'price',
      note: `${round(r, 2)}× the traded price — worth checking the inputs before relying on it.` })
  }

  // 2 — against fair value, which uses a different method on the same data.
  // Two independent routes disagreeing by this much means one of them is broken.
  if (fairValue?.low > 0 && fairValue?.high > 0) {
    const fvMid = (fairValue.low + fairValue.high) / 2
    const r = mid / fvMid
    // Tighter than the price check on purpose. Fair value and the estimate run
    // different methods over the SAME statements, so they should broadly agree;
    // price can legitimately sit far from both. SBIN sat at 0.60 of fair value
    // — inside a 0.4 threshold and still plainly wrong — which is what set this.
    if (r > 2 || r < 0.65) issues.push({ severity: 'medium', kind: 'fair-value',
      note: `Fair value says ${Math.round(fvMid)}, this estimate says ${Math.round(mid)} — ` +
            (r < 1
              ? 'the market has been paying less than the numbers suggest, and this reflects that.'
              : 'this projects more than the current numbers alone support.') })
  }

  // 3 — against consensus. Analysts can be wrong together, but being outside
  // their whole range by a multiple is a signal about our arithmetic.
  if (analystTarget?.low > 0 && analystTarget?.high > 0) {
    if (mid > analystTarget.high * 2) issues.push({ severity: 'medium', kind: 'consensus',
      note: `Above the entire analyst range (${Math.round(analystTarget.low)}–${Math.round(analystTarget.high)}) by more than double.` })
    else if (mid < analystTarget.low * 0.5) issues.push({ severity: 'medium', kind: 'consensus',
      note: `Below the entire analyst range (${Math.round(analystTarget.low)}–${Math.round(analystTarget.high)}) by more than half.` })
  }

  if (issues.length === 0) return null

  // Only a PRICE divergence marks the number unreliable. Fair value and this
  // estimate answer different questions — fair value asks what the numbers say
  // the business is worth, the estimate asks what the market is likely to pay —
  // and a persistent gap between them is exactly what a cheap or expensive stock
  // looks like. Treating that disagreement as a defect struck through estimates
  // that were doing their job, which is why a stock trading at a lasting
  // discount had its estimate crossed out for reporting the discount.
  const brokenModel = issues.some(i => i.severity === 'high' && i.kind === 'price')
  const high = issues.some(i => i.severity === 'high')
  return {
    reliable: !brokenModel,
    severity: brokenModel ? 'high' : high ? 'medium' : 'medium',
    issues: issues.map(i => i.note),
    // What to say when the number is shown. Suppressing it entirely would hide
    // the evidence that something is wrong; presenting it unmarked is worse.
    banner: brokenModel
      ? "This estimate doesn't hold up against the traded price — treat it as unreliable."
      : 'Worth knowing how this differs from the other readings.',
  }
}

/**
 * Compare a stored estimate against where the price actually went. The whole
 * reason estimates are frozen: without a dated prior claim there is nothing to
 * be right or wrong about.
 */
export function scoreEstimate(estimate, currentPrice) {
  if (!estimate?.ok || !(currentPrice > 0)) return null
  const { target, priceAtEstimate, createdAt, horizonYears = 1 } = estimate
  const elapsedDays = Math.floor((Date.now() - createdAt) / 86400000)
  const horizonDays = Math.round(horizonYears * 365)
  let outcome
  if (currentPrice >= target.high) outcome = 'above-range'
  else if (currentPrice >= target.low) outcome = 'in-range'
  else outcome = 'below-range'
  return {
    outcome, elapsedDays, horizonDays,
    matured: elapsedDays >= horizonDays,
    priceMovePct: round(((currentPrice - priceAtEstimate) / priceAtEstimate) * 100, 1),
    vsBasePct: round(((currentPrice - target.base) / target.base) * 100, 1),
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

function blank(note, extra = {}) {
  return {
    ok: false, note, target: null, upside: null, multiples: null,
    growth: null, growthPct: null, growthSource: 'none',
    degraded: [], basisSummary: null,
    priceAtEstimate: extra.price != null ? round(extra.price) : null,
  }
}
