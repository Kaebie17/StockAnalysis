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
import { justifiedMultiples, preferredForm, averagePayoutPct, determineROEStart } from './justifiedMultiple.js'
import { percentileSpread, filterRelativeOutliers } from './spread.js'
import { activeValue } from './dataQuality.js'
import { tableGrowthRate, tableRatioBasis, otherIncomeForecastBasis, latestRealRow, resolveAnnualRoe } from './formulas.js'

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)

// Every function below this point reads a plain .netProfit/.eps/.revenue/
// .totalEquity off whatever incomeHistory/balanceHistory it's handed — none
// of them know the reported/normalized toggle exists. Resolving it here,
// once, at buildEstimate's own entry (the one real entry point everything
// else in this file — the sector builders, targetMultiple, resolveMarginBasis,
// resolveDilution — is reached through), means that guarantee lives in the
// function itself rather than depending on every caller remembering to
// pre-resolve it independently before calling in (which is what useEstimate.js
// and PositionsPanel.jsx each used to do, identically, by hand).
function resolveHistoryBasis(incomeHistory, balanceHistory, basis) {
  const income = (incomeHistory || []).map(row => ({
    ...row,
    netProfit: activeValue(row, 'netProfit', basis),
    eps: activeValue(row, 'eps', basis),
    revenue: activeValue(row, 'revenue', basis),
  }))
  const balance = (balanceHistory || []).map(row => ({
    ...row,
    totalEquity: activeValue(row, 'totalEquity', basis),
  }))
  return { income, balance }
}

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
  const ps = percentileSpread(closes, { preferredSamples: 100 })
  if (!ps || !(ps.median > 0)) return null
  // The 15th-85th band as a fraction of the median, halved to a ± figure.
  const half = ((ps.high - ps.low) / ps.median) / 2

  // A steadily-priced stock genuinely has a narrow dispersion, and rejecting it
  // for being small was the same mistake as capping a high P/E — it discarded
  // the correct reading. Only a truly degenerate value (a flat series, or one
  // so wide the sample must span two regimes) is refused; the rest is used, with
  // a small floor so a range never collapses to a single number.
  if (!(half > 0) || half > 1) return null
  // Real data, computed regardless — a dispersion from fewer than 100 closes
  // is disclosed as thin, not hidden.
  return { half: Math.max(half, 0.03), thin: ps.thin }
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
 *
 * Takes whichever basis the caller's `incomeHistory` already represents
 * (reported, or reported-with-normalized-years-merged-in per the basis
 * toggle) rather than forcing reported regardless of it. An earlier version
 * hard-overrode to reported here on the theory that a normalized EPS
 * "measures a multiple nobody ever paid" — but this app's normalization is
 * a per-year correction of that YEAR's own contemporaneously-disclosed
 * one-off (a footnoted exceptional item in that year's own report), not a
 * hindsight-wide restatement, so that theory doesn't hold: it's typically
 * closer to what an adjusted-EPS-using analyst was pricing at the time than
 * raw reported earnings is. More decisively, the target this band feeds
 * (`target = multiple × forwardEps`) only means anything if the multiple
 * was itself measured as price ÷ THE SAME KIND of EPS being projected —
 * and the projection already follows the basis toggle (resolveMarginBasis
 * reads normalized years when the toggle is set), so forcing this band to
 * stay reported-only while the EPS it multiplies floats between bases was
 * multiplying two different definitions of earnings together.
 */
export function forwardPeBand(priceHistory = [], incomeHistory = [], opts = {}) {
  const { fyEndMonth = 3, normBasis = 'reported', balanceHistory = null, conditionalFilter = null } = opts

  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (closes.length === 0) return null

  const epsByYear = new Map()
  const netProfitByYear = new Map()
  // A loss year isn't excluded because it's an outlier to be filtered out —
  // P/E is mathematically undefined for negative earnings, dividing by a
  // negative number doesn't produce "a low multiple," it's a different,
  // meaningless quantity for this purpose. So it's not usable as a
  // year-to-price-against, but that's not the same as invisible: counted
  // here and disclosed by the caller (own.excludedLossYears), rather than
  // silently vanishing with nothing on screen saying a year was skipped.
  let excludedLossYears = 0
  for (const row of incomeHistory || []) {
    const y = yearOf(row), e = val(activeValue(row, 'eps', normBasis))
    if (y == null) continue
    if (e != null && e <= 0) { excludedLossYears++; continue }
    if (e > 0) {
      epsByYear.set(y, e)
      const np = val(activeValue(row, 'netProfit', normBasis))
      if (np != null) netProfitByYear.set(y, np)
    }
  }
  // Equity by year, only needed for the conditional-regime filter's ROE
  // dimension — cheap to collect regardless of whether conditionalFilter is
  // actually requested by the caller.
  const equityByYear = new Map()
  for (const bRow of balanceHistory || []) {
    const y = yearOf(bRow)
    const eq = val(activeValue(bRow, 'totalEquity', normBasis))
    if (y != null && eq > 0) equityByYear.set(y, eq)
  }

  const ratios = []
  // Per-year buckets — the daily ratios AND that year's own forward growth/
  // ROE, kept separate from the pooled `ratios` array above so the
  // conditional-regime filter below (when requested) can pool only the
  // ratios from years it actually judges comparable, rather than the whole
  // history at once.
  const yearBuckets = new Map()
  let pairedYears = 0
  // Consecutive-pair count — a year only has a forward EPS to price against if
  // y+1 is ALSO on record, which is the precondition for pairing at all,
  // separate from whether price history happens to overlap that window. A
  // gapped paste (years present but not consecutive) fails here even with a
  // long price history; thin price coverage fails at the overlap check below
  // even with a full consecutive run. Tracked separately so the diagnostic
  // below can tell the two apart instead of naming one wrong remedy for both.
  let consecutivePairs = 0
  // A missing y+1 only counts as a genuine gap if the series continues PAST
  // it — the most recent year on record naturally has no "next" year yet
  // (it hasn't happened), which isn't a gap, just where the series ends.
  const sortedYears = [...epsByYear.keys()].sort((a, b) => a - b)
  const missingYears = sortedYears.slice(0, -1)
    .filter(y => !epsByYear.has(y + 1))
    .map(y => y + 1)
  for (const [y] of epsByYear) {
    const nextEps = epsByYear.get(y + 1)
    if (!(nextEps > 0)) continue
    consecutivePairs++
    const end   = Date.UTC(y, fyEndMonth, 0)
    const start = Date.UTC(y - 1, fyEndMonth, 1)
    const bucket = []
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      const pe = c.close / nextEps
      if (pe > 0) { ratios.push(pe); bucket.push(pe) }
    }
    if (bucket.length) {
      pairedYears++
      // The fundamentals a market pricing THIS pair would actually be
      // betting on: the growth that turns year y's EPS into year y+1's
      // (the forward growth this observation implicitly prices), and ROE
      // contemporaneous with the EPS being priced (year y+1). Null when the
      // inputs to compute either aren't available — a year missing these
      // still contributes its ratios to the unconditioned band above, it
      // just can't be judged comparable-or-not by the filter below.
      const epsY = epsByYear.get(y)
      const growth = epsY > 0 ? (nextEps / epsY - 1) : null
      const npNext = netProfitByYear.get(y + 1)
      const eqNext = equityByYear.get(y + 1)
      const roe = (npNext != null && eqNext > 0) ? (npNext / eqNext) * 100 : null
      yearBuckets.set(y, { ratios: bucket, growth, roe })
    }
  }

  // Diagnose WHY a band can't be built — three distinct causes, three
  // different remedies, and only the first two are things pasting more data
  // fixes at all:
  //   1. Too few years of earnings on record at all.
  //   2. Enough years, but gaps between them break the year-to-year+1 pairing.
  //   3. A full consecutive run of years, but price history still doesn't
  //      overlap enough of them — not something pasting statements can fix
  //      (there's no price history to paste), most often because the pasted
  //      years reach back further than this stock has actually traded.
  //
  // Two paired years is the arithmetic minimum a percentile band needs — one
  // year is a single point with no low and no high. Every threshold above
  // that was a judgement call the user is better placed to make: the span
  // travels with the band, so a two-year window is visible as one and can be
  // weighed accordingly.
  const MIN_PAIRED_YEARS = 2
  if (pairedYears < MIN_PAIRED_YEARS) {
    const lossNote = excludedLossYears > 0
      ? ` (${excludedLossYears} loss year${excludedLossYears === 1 ? '' : 's'} also on record — excluded, P/E undefined for negative earnings)`
      : ''
    const reason =
      epsByYear.size < MIN_PAIRED_YEARS + 1
        ? `${epsByYear.size} year${epsByYear.size === 1 ? '' : 's'} of earnings gives no range to measure${lossNote} — paste the Screener tables for a fuller history`
        : consecutivePairs < MIN_PAIRED_YEARS
        ? `${epsByYear.size} years of earnings on record, but gaps between them` +
          `${missingYears.length ? ` (missing ${[...new Set(missingYears)].sort().join(', ')})` : ''}` +
          ` break the year-over-year pairing — paste the missing years to fill them in`
        : `${consecutivePairs} consecutive year${consecutivePairs === 1 ? '' : 's'} of earnings exist, but price history only overlaps ` +
          `${pairedYears} of them — more likely this stock's trading history than its statement history; pasting more Screener tables won't extend it`
    return { insufficient: true, pairedYears, consecutivePairs, samples: ratios.length,
             earningsYears: epsByYear.size, priceDays: closes.length, excludedLossYears, reason }
  }

  // A contaminated YEAR (a mid-year EPS restatement, a stub year producing a
  // near-zero denominator) puts an entire cluster of ratios at the same wrong
  // level — not isolated single-day noise percentile trimming alone would
  // catch, since percentiles only shave the most extreme individual points,
  // not a whole block sitting together away from the rest. Filtering on
  // distance from the RAW median first (median is itself robust to a
  // contaminated MINORITY of the data — the exact shape a single bad year
  // produces among several years of paired data) removes that cluster before
  // the percentiles are measured. Shared with pbBand and peerBand — see
  // spread.js.
  const cleaned = filterRelativeOutliers(ratios, { multiple: OUTLIER_MULTIPLE, minKeep: 20 })
  const ps = percentileSpread(cleaned, { preferredSamples: 100 })
  // Below percentileSpread's own structural floor despite enough paired
  // years — practically unreachable (each paired year contributes up to a
  // year's worth of daily ratios), but not assumed.
  if (!ps) {
    return { insufficient: true, pairedYears, samples: ratios.length,
             earningsYears: epsByYear.size, priceDays: closes.length, excludedLossYears,
             reason: `only ${ratios.length} priced day${ratios.length === 1 ? '' : 's'} overlap the paired years — too few to measure a range` }
  }
  // Percentiles, not min/max: one panic day or one melt-up shouldn't define the
  // band the whole projection hangs off.
  const result = {
    low: round(ps.low, 1), median: round(ps.median, 1), high: round(ps.high, 1),
    samples: ps.count,
    // How many years the band actually spans, so a three-year window and
    // a nine-year one can be told apart downstream.
    spanYears: pairedYears,
    // Real data, computed regardless — but a band from fewer than 100
    // pooled daily observations is disclosed as thinner than ideal
    // rather than hidden.
    thin: ps.thin,
    // Years where P/E is undefined (negative earnings) — declined,
    // not silently dropped. See the comment on epsByYear above.
    excludedLossYears,
  }

  // Conditional-regime filter (opt-in via conditionalFilter) — the band
  // above answers "what has this stock traded at, ever"; this answers "what
  // has it traded at in years whose growth/ROE resembles the year being
  // forecast." A historical high traded off a near-zero earnings base, or a
  // crisis-year collapse-and-recovery, describes a regime the forecast year
  // may not be in at all — pooling it into an unconditioned percentile band
  // and calling that band the FORWARD range is exactly the distortion this
  // exists to correct. Kept as a strictly additive field: existing callers
  // that don't pass conditionalFilter see no change to what's returned above.
  if (conditionalFilter && conditionalFilter.forecastGrowth != null && conditionalFilter.forecastRoe != null) {
    const buckets = [...yearBuckets.entries()]
    const growthVals = buckets.map(([, b]) => b.growth).filter(g => g != null)
    const roeVals = buckets.map(([, b]) => b.roe).filter(r => r != null)
    const madOf = arr => {
      if (arr.length < 2) return null
      const sorted = [...arr].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      const devs = arr.map(x => Math.abs(x - median)).sort((a, b) => a - b)
      return devs[Math.floor(devs.length / 2)]
    }
    // Floors, not derived constants — a company whose growth or ROE has
    // barely varied across its own history would otherwise divide by a
    // near-zero MAD and make the filter pathological (any tiny deviation
    // reading as "incomparable"). 1 percentage point on each axis is a
    // disclosed governance floor, same standing as COMPARABLE_REGIME_DISTANCE
    // below, not a statistically fitted number.
    const gScale = Math.max(madOf(growthVals) ?? 0, 0.01)
    const rScale = Math.max(madOf(roeVals) ?? 0, 1.0)
    // Governance convention, not a discovered statistical threshold — one
    // robust standardized unit of joint growth/ROE distance counts as
    // "comparable." A year missing one dimension is judged on the other
    // alone rather than excluded outright (a company with unmeasurable ROE
    // some years shouldn't lose those years from the filter entirely).
    const COMPARABLE_REGIME_DISTANCE = 1.0
    const considered = []
    const comparable = []
    for (const [y, b] of buckets) {
      if (b.growth == null && b.roe == null) continue
      considered.push(y)
      const gTerm = b.growth != null ? (b.growth - conditionalFilter.forecastGrowth) / gScale : 0
      const rTerm = b.roe != null ? (b.roe - conditionalFilter.forecastRoe) / rScale : 0
      const d = Math.sqrt(gTerm * gTerm + rTerm * rTerm)
      if (d <= COMPARABLE_REGIME_DISTANCE) comparable.push(y)
    }
    // Confidence tiers, same standing as targetMultiple.js's own
    // fragile/moderate/stronger labels — descriptive of how much evidence
    // backs the band, not a statistical guarantee. Below 3 retained years a
    // percentile band is dominated by individual observations (the same
    // MIN_PAIRED_YEARS-style floor the unconditioned band already respects).
    const retainedCount = comparable.length
    const confidence = retainedCount >= 5 ? 'usable' : retainedCount >= 3 ? 'weak' : 'none'
    const conditionalOwn = { observationsConsidered: considered.length, observationsRetained: retainedCount, confidence }
    if (confidence !== 'none') {
      const pooled = comparable.flatMap(y => yearBuckets.get(y).ratios)
      const cCleaned = filterRelativeOutliers(pooled, { multiple: OUTLIER_MULTIPLE, minKeep: Math.min(20, pooled.length) })
      const cPs = percentileSpread(cCleaned, { minSamples: 2, preferredSamples: 100 })
      if (cPs) {
        conditionalOwn.low = round(cPs.low, 1)
        conditionalOwn.median = round(cPs.median, 1)
        conditionalOwn.high = round(cPs.high, 1)
        conditionalOwn.samples = cPs.count
      } else {
        conditionalOwn.confidence = 'none'
      }
    }
    result.conditionalOwn = conditionalOwn
  }

  return result
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
  //
  // Two distinct reasons a year is excluded, tracked separately rather than
  // silently dropped, same reasoning as forwardPeBand's loss-year count:
  //   - negative/zero book equity — P/B is genuinely undefined here, same
  //     class of issue as P/E for negative earnings.
  //   - a loss year (net profit <= 0) breaks the profit/EPS share-count
  //     derivation this function relies on — a methodological limitation
  //     of THIS function, not a claim that the year itself is meaningless.
  const bpsByYear = new Map()
  let excludedNegativeEquityYears = 0
  let excludedLossYears = 0
  for (const bRow of balanceHistory || []) {
    const y = yearOf(bRow)
    const eq = val(bRow?.totalEquity)
    if (y == null) continue
    if (eq != null && eq <= 0) { excludedNegativeEquityYears++; continue }
    if (!(eq > 0)) continue
    const iRow = (incomeHistory || []).find(r => yearOf(r) === y)
    const np = val(iRow?.netProfit), eps = val(iRow?.eps)
    const sharesThen = (np > 0 && eps > 0) ? np / eps : null
    if (!(sharesThen > 0)) { if (np != null && np <= 0) excludedLossYears++; continue }
    bpsByYear.set(y, eq / sharesThen)
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
      if (pb > 0) ratios.push(pb)
    }
  }
  // Same relative outlier filter as forwardPeBand, for the same reason: a
  // fixed absolute ceiling (this used to be a flat 0.2-12x) is a judgement
  // about what the market is allowed to pay that has no basis, and would
  // silently discard every real observation for a stock that genuinely
  // trades outside it (a high-growth compounder above 12x book is unusual
  // but real, not a data artifact) — exactly the mistake already found and
  // fixed for P/E. Measured from the stock's OWN distribution instead;
  // shared implementation in spread.js.
  const cleaned = filterRelativeOutliers(ratios, { multiple: OUTLIER_MULTIPLE, minKeep: 20 })
  const ps = percentileSpread(cleaned, { preferredSamples: 100 })
  if (!ps) return null
  return { low: round(ps.low, 2), median: round(ps.median, 2), high: round(ps.high, 2),
           samples: ps.count,
           // Real data, computed regardless — a band from fewer than 100
           // pooled daily observations is disclosed as thin, not hidden.
           thin: ps.thin,
           // Excluded, not silently dropped — see the comment on bpsByYear above.
           excludedNegativeEquityYears, excludedLossYears }
}

// "Near zero" relative to the company's OWN normal scale — a flat rupee
// threshold means nothing across the wildly different EPS scales this app
// sees; a fraction of the company's own median positive EPS does. Shared
// between measurePeDiagnostics (computes nearZeroFrequency with it) and
// assessPeSuitability (states it in the reason text), so the two stay
// consistent without measurePeDiagnostics needing to know it's a threshold.
const NEAR_ZERO_FRACTION = 0.15

/**
 * Raw measurement only — every number below is directly calculated from
 * reported EPS history (and, for the peMedian/peMAD/peDispersion group,
 * price history), none of it is a threshold or a verdict. Split out from
 * assessPeSuitability (which used to compute AND classify in one function)
 * so a threshold can change without touching how any of these are measured,
 * and so a future caller can read the diagnostics without also getting an
 * opinion attached.
 */
export function measurePeDiagnostics(incomeHistory = [], basis = 'reported', priceHistory = []) {
  const rows = (incomeHistory || [])
    .map(r => ({ year: yearOf(r), eps: val(activeValue(r, 'eps', basis)) }))
    .filter(r => r.year != null && r.eps != null)
    .sort((a, b) => a.year - b.year)

  const totalYears = rows.length
  const profitable = rows.filter(r => r.eps > 0)
  const profitCoverage = totalYears > 0 ? profitable.length / totalYears : null

  const sortedPositive = [...profitable.map(r => r.eps)].sort((a, b) => a - b)
  const medianPositiveEps = sortedPositive.length ? sortedPositive[Math.floor(sortedPositive.length / 2)] : null
  const nearZeroCount = medianPositiveEps > 0
    ? rows.filter(r => Math.abs(r.eps) < medianPositiveEps * NEAR_ZERO_FRACTION).length : 0
  const nearZeroFrequency = totalYears > 0 ? nearZeroCount / totalYears : null

  // Growth volatility — YoY EPS growth, profitable-to-profitable years only
  // (a percentage change from or to a loss isn't a real growth rate). MAD
  // (median absolute deviation), not standard deviation: robust to one
  // freak year rather than dominated by it — same reasoning resolveDilution
  // already uses its own median/outlier filter for.
  const growthSteps = []
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].eps > 0 && rows[i].eps > 0) growthSteps.push(rows[i].eps / rows[i - 1].eps - 1)
  }
  let epsGrowthMAD = null
  if (growthSteps.length >= 2) {
    const sorted = [...growthSteps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const absDevs = growthSteps.map(g => Math.abs(g - median)).sort((a, b) => a - b)
    epsGrowthMAD = absDevs[Math.floor(absDevs.length / 2)]
  }

  // Drawdown from the running peak, and how often a real collapse (≥20%)
  // was later recovered — the repeated-cycle signature plain noise doesn't
  // have. Loss years don't participate here at all (profitCoverage above
  // already captures them) — a loss following a positive peak has no
  // bounded percentage-from-peak (a peak of 8 followed by a loss of -1 is a
  // "112% drawdown," unbounded and worse the smaller the peak was), which
  // would flag any single occasional loss year as a severe collapse. This
  // tracks how far EARNINGS POWER has fallen among the years it was
  // actually still positive — a company with two scattered loss years and
  // otherwise steady growth correctly reads as having little drawdown, not
  // an extreme one.
  const DRAWDOWN_THRESHOLD = 0.20
  let peak = null, maxDrawdown = 0, inDrawdown = false, cycleCount = 0
  for (const r of rows) {
    if (r.eps <= 0) continue
    if (peak == null || r.eps > peak) {
      if (inDrawdown && peak > 0 && r.eps >= peak * (1 - DRAWDOWN_THRESHOLD)) { cycleCount++; inDrawdown = false }
      peak = r.eps
      continue
    }
    if (peak > 0) {
      const drawdown = r.eps / peak - 1
      if (drawdown < maxDrawdown) maxDrawdown = drawdown
      if (drawdown <= -DRAWDOWN_THRESHOLD) inDrawdown = true
    }
  }
  const cycleFrequency = totalYears > 0 ? cycleCount / totalYears : 0

  // Historical P/E dispersion — a different reliability question than every
  // diagnostic above, which is entirely about the EARNINGS (coverage,
  // near-zero years, growth volatility, drawdowns). A company can have
  // perfectly steady, always-profitable EPS and still carry an unreliable
  // P/E anchor if the MARKET has re-rated it wildly over the same span (a
  // growth story re-rated toward a value multiple, or the reverse) — none
  // of the earnings-side diagnostics would ever see that, because the
  // earnings themselves were fine throughout.
  //
  // Same year-to-price pairing convention multipleSpread already uses
  // (price during fiscal year y ÷ year y's own reported EPS, April-March,
  // loss years excluded since P/E is undefined there) — exposed here as a
  // raw measurement only, no threshold attached, same as everything else
  // in this function. Inherits the same look-ahead-timing question already
  // flagged for multipleSpread/pbBand (a mid-year price divided by a
  // full-year EPS not yet reported at that point) — this diagnostic doesn't
  // attempt to independently fix that, just reuses the existing convention.
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
  const peRatios = []
  for (const r of rows) {
    if (!(r.eps > 0)) continue
    const start = Date.UTC(r.year - 1, 3, 1), end = Date.UTC(r.year, 3, 0)
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      peRatios.push(c.close / r.eps)
    }
  }
  let peMedian = null, peMAD = null, peDispersion = null
  if (peRatios.length >= 4) {
    const sortedPe = [...peRatios].sort((a, b) => a - b)
    peMedian = sortedPe[Math.floor(sortedPe.length / 2)]
    const peDevs = peRatios.map(p => Math.abs(p - peMedian)).sort((a, b) => a - b)
    peMAD = peDevs[Math.floor(peDevs.length / 2)]
    peDispersion = peMedian > 0 ? peMAD / peMedian : null
  }

  return {
    totalYears, profitableYears: profitable.length, profitCoverage,
    nearZeroYears: nearZeroCount, nearZeroFrequency,
    epsGrowthMAD, maxDrawdown, cycleCount, cycleFrequency,
    peMedian, peMAD, peDispersion, peSamples: peRatios.length,
  }
}

/**
 * Whether this company's own earnings history makes P/E a meaningful
 * valuation anchor at all — a different, earlier question than whether a
 * REGRESSION on top of that anchor is reliable (targetMultiple.js's own
 * gates already handle that, once there's an anchor worth adjusting). A
 * company can clear every regression gate cleanly while the underlying P/E
 * anchor itself is conditional on "whichever years it happened to be
 * profitable" — frequent losses or earnings that sit near zero mean a
 * single historical P/E median describes a slice of the business's story,
 * not the whole of it.
 *
 * Deliberately NOT keyed off detectSectorType's 'cyclical' keyword flag —
 * that only catches sectors the keyword list happens to name (commodities,
 * steel, ...). A company that's earnings-volatile for its own reasons (a
 * one-off write-down, a demand shock, an industry the list doesn't cover)
 * passes straight through a sector-name check. This measures the actual
 * reported EPS history instead, so it catches both.
 *
 * Recurring-cycle evidence (`recurringCyclicalEvidence`) is measured here
 * but deliberately kept OUT of the suitability verdict: a single
 * collapse-and-recovery is exactly as consistent with a one-off shock
 * (COVID, an acquisition, a regulatory change, a write-down) as with a
 * genuinely cyclical business — one instance can't prove a repeating
 * pattern. Two or more completed cycles is the actual recurring signature,
 * and it's returned as its own field precisely so the caller (buildEstimate)
 * can use it to choose TREATMENT (through-cycle vs standard) without that
 * choice being smuggled into whether P/E is "unsuitable" — a company can be
 * cyclical AND have perfectly usable per-cycle P/E history, and a company
 * can have unusable P/E (too few profitable years, too little history) for
 * reasons that have nothing to do with cyclicality at all — a turnaround
 * (early losses, then a real fix, now sustained profit) is exactly that
 * case, and shouldn't be routed to a through-cycle model that assumes the
 * whole history is one undifferentiated cycle.
 *
 * Thresholds below are disclosed calibration choices — same standing as
 * targetMultiple.js's MIN_R2/LOO_DEVIATION_BAND — not derived statistical
 * constants.
 */
export function assessPeSuitability(diagnostics) {
  const { totalYears, profitableYears, profitCoverage, nearZeroYears, nearZeroFrequency,
          maxDrawdown, cycleCount } = diagnostics || {}
  const recurringCyclicalEvidence = (cycleCount ?? 0) >= 2

  // Too little history to say anything at all — a different state than
  // "suitable," which used to be the silent default here. Whatever reads
  // this verdict needs to know the difference between "checked, and it's
  // fine" and "never actually checked."
  if (totalYears == null || totalYears < 4) {
    return {
      suitability: 'insufficient_history', recurringCyclicalEvidence,
      reasons: [`Only ${totalYears ?? 0} year${totalYears === 1 ? '' : 's'} of earnings history — too little to assess whether P/E is a reliable basis here.`],
      ...diagnostics,
    }
  }

  const reasons = []
  let suitability = 'suitable'
  if (profitCoverage < 0.5) {
    suitability = 'unsuitable'
    reasons.push(`Only ${profitableYears} of ${totalYears} years were profitable — too little P/E history to anchor a valuation on.`)
  } else if (profitCoverage < 0.7 || nearZeroFrequency >= 0.3 || recurringCyclicalEvidence
             || (cycleCount === 1 && maxDrawdown <= -0.25)) {
    suitability = 'questionable'
    if (profitCoverage < 0.7) reasons.push(`Only ${profitableYears} of ${totalYears} years were profitable.`)
    if (nearZeroFrequency >= 0.3) reasons.push(`EPS sat near zero (under ${round(NEAR_ZERO_FRACTION * 100, 0)}% of its own typical level) in ${nearZeroYears} of ${totalYears} years.`)
    if (recurringCyclicalEvidence) {
      reasons.push(`Earnings have repeatedly collapsed (as much as ${round(Math.abs(maxDrawdown) * 100, 0)}%) and recovered ${cycleCount} times — a single historical P/E doesn't describe a business that moves through cycles this often.`)
    } else if (cycleCount === 1 && maxDrawdown <= -0.25) {
      reasons.push(`Earnings drew down as much as ${round(Math.abs(maxDrawdown) * 100, 0)}% from a prior peak before recovering once — a single instance, not yet an established pattern.`)
    }
  }

  return { suitability, recurringCyclicalEvidence, reasons, ...diagnostics }
}

/**
 * Raw measurement only, same split as measurePeDiagnostics — whether
 * EBITDA is a meaningful, reliable enterprise-valuation base is a
 * DIFFERENT question from whether P/E is usable, not a weaker substitute
 * for it. A company can have perfectly fine P/E and still have EBITDA
 * that's positive only because of one exceptional year, or vice versa.
 */
export function measureEbitdaDiagnostics(incomeHistory = [], basis = 'reported', balanceHistory = []) {
  const rows = (incomeHistory || [])
    .map(r => ({ year: yearOf(r), ebitda: val(activeValue(r, 'ebitda', basis)), revenue: val(activeValue(r, 'revenue', basis)) }))
    .filter(r => r.year != null && r.ebitda != null)
    .sort((a, b) => a.year - b.year)

  const totalYears = rows.length
  const positive = rows.filter(r => r.ebitda > 0)
  const ebitdaCoverage = totalYears > 0 ? positive.length / totalYears : null

  // Margin stability — MAD of EBITDA margin across years with revenue,
  // same robust-to-one-freak-year approach measurePeDiagnostics already
  // uses for epsGrowthMAD.
  const margins = rows.filter(r => r.revenue > 0).map(r => r.ebitda / r.revenue)
  let medianMargin = null, marginMAD = null
  if (margins.length >= 2) {
    const sorted = [...margins].sort((a, b) => a - b)
    medianMargin = sorted[Math.floor(sorted.length / 2)]
    const devs = margins.map(m => Math.abs(m - medianMargin)).sort((a, b) => a - b)
    marginMAD = devs[Math.floor(devs.length / 2)]
  }

  // Exceptional-period dependence: does a SINGLE year account for most of
  // the positive EBITDA on record? Same "one dominant year" shape
  // otherIncomeForecastBasis's maxShare check already guards other income
  // with — a company whose "positive EBITDA" is really one good year isn't
  // showing a sustained operating level.
  const totalPositiveEbitda = positive.reduce((s, r) => s + r.ebitda, 0)
  const maxYearShare = totalPositiveEbitda > 0
    ? Math.max(...positive.map(r => r.ebitda)) / totalPositiveEbitda : null

  // Enterprise-value relevance: the EV-to-equity bridge needs BOTH debt and
  // cash actually reported, not assumed — same standard the DCF/WACC
  // computation already holds itself to.
  const latestBal = latestRealRow((balanceHistory || []).filter(x => !x?.synthetic))
  const totalDebt = val(activeValue(latestBal, 'totalDebt', basis))
  const cash = val(activeValue(latestBal, 'cash', basis))
  const netDebtMeasurable = totalDebt != null && cash != null

  return {
    totalYears, positiveYears: positive.length, ebitdaCoverage,
    medianMargin, marginMAD, maxYearShare, netDebtMeasurable,
  }
}

/**
 * Whether EBITDA is a meaningful, reliable base for an enterprise-value
 * valuation — the EBITDA-side counterpart to assessPeSuitability. A
 * capital-intensive/yield sector tag says "EV/EBITDA might be the right
 * lens for this kind of business"; this is what actually establishes
 * whether it is, for THIS company. Same four-state shape and same
 * calibration numbers as assessPeSuitability (0.5/0.7 coverage tiers) —
 * reusing the same thresholds keeps the two gates internally consistent
 * rather than each carrying its own independently-chosen convention.
 */
export function assessEbitdaSuitability(diagnostics) {
  const { totalYears, positiveYears, ebitdaCoverage, medianMargin, marginMAD, maxYearShare, netDebtMeasurable } = diagnostics || {}

  if (totalYears == null || totalYears < 4) {
    return {
      suitability: 'insufficient_history',
      reasons: [`Only ${totalYears ?? 0} year${totalYears === 1 ? '' : 's'} of EBITDA history — too little to assess whether it's a reliable valuation base.`],
      ...diagnostics,
    }
  }

  const reasons = []
  let suitability = 'suitable'
  if (ebitdaCoverage < 0.5) {
    suitability = 'unsuitable'
    reasons.push(`Only ${positiveYears} of ${totalYears} years had positive EBITDA — too little to anchor an enterprise valuation on.`)
  } else if (!netDebtMeasurable) {
    suitability = 'unsuitable'
    reasons.push(`Debt and/or cash aren't both reported — the enterprise-to-equity bridge can't be built.`)
  } else if (ebitdaCoverage < 0.7
             || (maxYearShare != null && maxYearShare > 0.5 && positiveYears >= 2)
             || (medianMargin > 0 && marginMAD != null && (marginMAD / medianMargin) > 0.5)) {
    suitability = 'questionable'
    if (ebitdaCoverage < 0.7) reasons.push(`Only ${positiveYears} of ${totalYears} years had positive EBITDA.`)
    if (maxYearShare != null && maxYearShare > 0.5 && positiveYears >= 2) {
      reasons.push(`A single year accounts for over half the positive EBITDA on record — recent EBITDA may reflect one exceptional period rather than a sustained level.`)
    }
    if (medianMargin > 0 && marginMAD != null && (marginMAD / medianMargin) > 0.5) {
      reasons.push(`EBITDA margin has swung widely year to year relative to its own median — less confidence the latest margin is representative.`)
    }
  }

  return { suitability, reasons, ...diagnostics }
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
          multipleOverride = null, growthOverride = null, basis } = opts
  const price = ratioResult?.price
  const bps = ratioResult?.ratios?.bookPerShare?.value ?? ratioResult?.bookPerShare
  // roe/payout are table-native — read off the latest real row directly,
  // falling back to ratioResult only when the table can't resolve one (e.g.
  // snapshotRebuild.js's historical "as of" reconstruction, whose truncated
  // income slice may not carry every materialized field).
  const incRowL = latestRealRow(incomeHistory)
  // ROE: the same shared answer (resolveAnnualRoe, formulas.js) every
  // ROE-based method here uses, rather than this model's own independent
  // 3-year ladder — see its own doc comment for why the figure itself
  // shouldn't drift between methods even though how each turns it into a
  // price legitimately does.
  const roeResolved = resolveAnnualRoe({ incomeHistory, balanceHistory, basis, ratioResult })
  const fallbackRoe = roeResolved.value ?? activeValue(incRowL, 'roe', basis)?.value ?? ratioResult?.ratios?.roe?.value
  let roe = fallbackRoe
  let roeSource = roeResolved.source
  // Same principle as justifiedMultiple.js's determineROEStart: a current,
  // mid-year quarterly run-rate beats a stale annual median wherever one is
  // actually available. Without this, the book-compounding growth rate here
  // kept using a 3-year median (e.g. 46%) even after quarterly data showed
  // the current year running well below it — the two models then disagreed
  // for no defensible reason, since both are answering the same "what's this
  // company's ROE right now" question.
  if (fallbackRoe != null) {
    const started = determineROEStart({
      data: { reportedIncomeHistory: incomeHistory, quarterlyHistory: opts.quarterlyHistory || [] },
      basis, fallbackRoe, latestBalRow: latestRealRow(balanceHistory),
    })
    if (started.source !== '3-year annual median') { roe = started.roe; roeSource = started.source }
  }
  const payout = activeValue(incRowL, 'dividendPayout', basis)?.value ?? ratioResult?.ratios?.dividendPayout?.value
  if (!(bps > 0)) return null

  // Retention from the payout actually reported. Where the latest year is
  // missing it, the company's own historical average payout is used — the
  // flat 80% it used to fall back to was a number I chose, and it fires on
  // exactly the companies whose data is thinnest.
  // Payout from the actual data, in order of directness: reported latest →
  // company's own historical average → derived from dividend/cashflow/yield.
  // No sector-average guess: if none of the company's own figures yield a
  // payout, this model can't run and defers to the others (DCF, multiples).
  const histPayout = averagePayout(opts.incomeHistory)
  let payoutPct = (payout != null && payout >= 0 && payout <= 100) ? payout : histPayout
  if (payoutPct == null) {
    payoutPct = averagePayoutPct(incomeHistory, {
      cashflowHistory: opts.cashflowHistory || [],
      dividendYield: ratioResult?.ratios?.dividendYield?.value ?? null,
      pe: ratioResult?.ratios?.pe?.value ?? null,
    })
  }
  if (payoutPct == null) return null   // no derivable dividend data → defer to other models
  const retention = 1 - payoutPct / 100
  const growth = growthOverride != null ? growthOverride
    : (roe > 0 ? (roe / 100) * retention : null)
  if (growth == null) return null

  const forwardBook = bps * Math.pow(1 + growth, years)

  // Same basis as the projection this band is applied to — see forwardPeBand's
  // docblock for why forcing this to reported regardless of the toggle was wrong.
  const band = pbBand(priceHistory, balanceHistory, incomeHistory)
  const currentPb = ratioResult?.ratios?.pb?.value ?? (price > 0 ? price / bps : null)
  // Spread width when no measured P/B band exists: this stock's own price
  // dispersion (needs only closes, not paired book value — clears where the
  // stricter pbBand can't) rather than a flat ±25% that says the same thing
  // about every company. Declines (null — the caller falls through to the
  // generic chain) when even that isn't measurable, rather than guessing.
  let multiples, multipleBasis, multipleLabel, thinDispersion = false
  if (multipleOverride > 0) {
    let spread = band && band.median > 0
      ? { lo: band.low / band.median, hi: band.high / band.median }
      : null
    if (!spread) {
      const dd = priceDispersion(priceHistory)
      if (dd == null) return null
      spread = { lo: 1 - dd.half, hi: 1 + dd.half }
      thinDispersion = dd.thin
    }
    multiples = { low: round(multipleOverride * spread.lo, 2), base: round(multipleOverride, 2),
                  high: round(multipleOverride * spread.hi, 2) }
    multipleBasis = 'revision'; multipleLabel = `your re-rating (${round(multipleOverride, 2)}× book)`
  } else if (band) {
    multiples = { low: band.low, base: band.median, high: band.high }
    multipleBasis = 'observed'
    // Disclosed, not hidden: both are real exclusions with a stated
    // reason, not values quietly dropped as noise. See pbBand's bpsByYear
    // comment for why these two are tracked separately.
    const excl = []
    if (band.excludedNegativeEquityYears > 0)
      excl.push(`${band.excludedNegativeEquityYears} negative-equity year${band.excludedNegativeEquityYears === 1 ? '' : 's'} (P/B undefined)`)
    if (band.excludedLossYears > 0)
      excl.push(`${band.excludedLossYears} loss year${band.excludedLossYears === 1 ? '' : 's'} (share count undeterminable)`)
    multipleLabel = `its own P/B range (${band.samples} days)` +
      (excl.length ? ` (excludes ${excl.join(', ')})` : '')
    thinDispersion = !!band.thin
  } else if (currentPb > 0) {
    const dd = priceDispersion(priceHistory)
    if (dd == null) return null
    const d = dd.half
    thinDispersion = dd.thin
    multiples = { low: round(currentPb * (1 - d), 2), base: round(currentPb, 2), high: round(currentPb * (1 + d), 2) }
    multipleBasis = 'current'; multipleLabel = `today's P/B ±${Math.round(d * 100)}% (its own price dispersion, no usable multiple history)`
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
  if (thinDispersion)
    degraded.push('Spread width from a thinner-than-usual sample of trading days')

  return {
    ok: true, model: 'lender',
    createdAt: Date.now(), horizonYears: years,
    priceAtEstimate: round(price),
    bookPerShare: round(bps), forwardBook: round(forwardBook),
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'roe-retention',
    growthLabel: growthOverride != null ? (opts.overrideLabel || 'an applied revision')
      : `${round(roe, 1)}% ROE (${roeSource}) × ${round(retention * 100, 0)}% retained`,
    marginPct: null, marginLabel: 'not applicable to a lender', marginSource: 'n/a',
    dilutionPct: 0, dilutionLabel: 'book already net of issuance',
    multiples, multipleBasis, multipleLabel,
    target, upside, degraded,
    epsPath: 'book × (ROE × retention) × P/B',
    basisSummary: `Book compounding at ${round(growth * 100, 1)}% (${round(roe, 1)}% ROE, ${roeSource} × ${round(retention * 100, 0)}% retained) · Multiple: ${multipleLabel}`,
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
  if (!isFinite(growth)) return null

  return {
    growth,
    years: span,                       // what was ACTUALLY used
    requested: years,
    truncated: span < years,
    from: start.y, to: end.y,
    // A rate outside this range is unusual — likely a recovery from a
    // collapsed base or a one-off — but it's real, computed data, not a
    // reason to hide it. Flagged so the caller can decide, not discarded.
    unusual: growth > 0.6 || growth < -0.3,
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

  // A CAGR outside this range is unusual — likely a recovery from a
  // collapsed base or a one-off — but it's real, computed data, not a
  // reason to hide it. Flagged so the caller can decide, not discarded.
  const unusual = growth > 0.6 || growth < -0.3

  return { growth, label: label || `${field} CAGR`, years, from: first.year, to: last.year, unusual }
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
  if (closes.length === 0) return null

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
  const ps = percentileSpread(ratios, { preferredSamples: 100 })
  if (!ps || !(ps.median > 0)) return null
  const lo = ps.low / ps.median, hi = ps.high / ps.median
  // A degenerate spread (all observations identical) would collapse the range.
  if (!(lo > 0.3) || !(hi < 3) || hi <= lo) return null
  // Real data, computed regardless — a spread from fewer than 100 pooled
  // ratio observations is disclosed as thin, not hidden.
  return { lo, hi, samples: ps.count, thin: ps.thin }
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
          multipleOverride = null, growthOverride = null, peerBand = null, basis } = opts
  const price = ratioResult?.price
  // revenue/eps/netProfit read off the SAME resolved incomeHistory the
  // mid-cycle decomposition below already uses, rather than a separately-
  // sourced ratioResult scalar that could in principle disagree with it.
  // Falls back to ratioResult when the table can't resolve one (see
  // buildLenderEstimate's note on snapshotRebuild.js's historical
  // reconstruction).
  const latestInc = latestRealRow(incomeHistory)
  const revenue = val(latestInc?.revenue) ?? ratioResult?.revenue
  const eps = val(latestInc?.eps) ?? ratioResult?.eps
  const netProfit = val(latestInc?.netProfit) ?? ratioResult?.netProfit
  if (!(revenue > 0) || !(eps > 0) || !(netProfit > 0)) return null

  // Mid-cycle earnings, decomposed the SAME six-node way the standard chain's
  // waterfall is (Revenue → EBITDA → EBIT → PBT → NetProfit) — not a single
  // undifferentiated net-margin number. The difference here is the BASIS each
  // driver is read from: the standard waterfall's tableRatioBasis defaults to
  // a 3-year window because a normal business's last 3 years are a reasonable
  // read on where it's headed, but a commodity business's last 3 years are
  // just as likely to be all-peak or all-trough — exactly the distortion the
  // old flat net-margin median existed to correct. Passing the full history
  // length as the window makes tableRatioBasis take the median across
  // whatever's available instead, the same "spans more of a cycle than a
  // short average" principle the old margin-only version used, now applied to
  // every driver instead of just the bottom line.
  const cyclicalData = { reportedIncomeHistory: incomeHistory, balanceHistory, basis }
  const throughCycleYears = incomeHistory.length
  const ebitdaMarginBasis = tableRatioBasis(cyclicalData, 'ebitdaMargin', basis, { years: throughCycleYears })
  if (ebitdaMarginBasis.yearsUsed < 4) return null          // too short to contain a cycle
  const daBasis = tableRatioBasis(cyclicalData, 'daToRevenue', basis, { years: throughCycleYears })
  const interestBasis = tableRatioBasis(cyclicalData, 'netInterestToRevenue', basis, { years: throughCycleYears })
  const otherIncomeBasis = otherIncomeForecastBasis(cyclicalData, basis)
  const taxBasis = tableRatioBasis(cyclicalData, 'effectiveTaxRate', basis, {
    years: throughCycleYears,
    filterYear: p => (activeValue(p.row, 'profitBeforeTax', basis)?.value ?? -1) > 0,
  })
  const currentMargin = netProfit / revenue

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

  const mcEbitda = projRevenue * (ebitdaMarginBasis.value / 100)
  const mcDa = daBasis.value != null ? projRevenue * (daBasis.value / 100) : 0
  const mcEbit = mcEbitda - mcDa
  const mcInterest = interestBasis.value != null ? projRevenue * (interestBasis.value / 100) : 0
  const mcOtherIncome = projRevenue * (otherIncomeBasis.value ?? 0)
  const mcPbt = mcEbit - mcInterest + mcOtherIncome
  const mcTaxRate = taxBasis.value != null ? Math.max(0, Math.min(1, taxBasis.value / 100)) : 0
  const mcTax = mcPbt > 0 ? mcPbt * mcTaxRate : 0
  const normalisedProfit = mcPbt - mcTax
  const midCycleMargin = normalisedProfit / projRevenue          // net-margin equivalent, for disclosure
  if (!(normalisedProfit > 0)) return null
  const normalisedEps = normalisedProfit / shares

  // The multiple is applied to NORMALISED earnings, so it must be a
  // through-cycle multiple too — the median of what the market paid across the
  // same span, not today's. Same basis (reported/normalized, per the toggle)
  // as the projection too — see forwardPeBand's docblock.
  const bandRaw = forwardPeBand(priceHistory, incomeHistory)
  const band = bandRaw?.insufficient ? null : bandRaw
  // Spread width: the real through-cycle band's own shape when one exists
  // (this override branch previously ignored `band` even when available and
  // always used a flat ±15% instead) — falls back to this stock's own price
  // dispersion, then declines rather than guessing a width.
  let multiples, multipleBasis, multipleLabel, thinDispersion = false
  if (multipleOverride > 0) {
    let spread = band && band.median > 0
      ? { lo: band.low / band.median, hi: band.high / band.median }
      : null
    if (!spread) {
      const dd = priceDispersion(priceHistory)
      if (dd == null) return null
      spread = { lo: 1 - dd.half, hi: 1 + dd.half }
      thinDispersion = dd.thin
    }
    multiples = { low: round(multipleOverride * spread.lo, 1), base: multipleOverride, high: round(multipleOverride * spread.hi, 1) }
    multipleBasis = 'revision'; multipleLabel = `your re-rating (${round(multipleOverride, 1)}×)`
  } else if (band) {
    multiples = { low: band.low, base: band.median, high: band.high }
    multipleBasis = 'observed'; multipleLabel = `through-cycle P/E (${band.samples} days)`
    thinDispersion = !!band.thin
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
    epsPath: 'revenue → EBITDA → EBIT → PBT → net profit ÷ shares, every driver through-cycle',
    marginPct: round(midCycleMargin * 100, 1),
    marginLabel: `mid-cycle net margin (implied by through-cycle EBITDA margin ${round(ebitdaMarginBasis.value, 1)}%, ${ebitdaMarginBasis.yearsUsed}yr median)`,
    marginSource: 'normalised',
    currentMarginPct: round(currentMargin * 100, 1),
    cyclePosition,
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'cagr',
    growthLabel: `${growthInfo.label} — margins normalised separately`,
    dilutionPct: 0, dilutionLabel: 'not modelled for a cyclical',
    multiples, multipleBasis, multipleLabel,
    target, upside,
    drivers: {
      ebitdaMarginPct: round(ebitdaMarginBasis.value, 1), ebitdaMarginSource: ebitdaMarginBasis.source,
      daToRevenuePct: daBasis.value != null ? round(daBasis.value, 1) : null,
      netInterestToRevenuePct: interestBasis.value != null ? round(interestBasis.value, 1) : null,
      otherIncomeToRevenuePct: otherIncomeBasis.value ? round(otherIncomeBasis.value * 100, 2) : 0,
      otherIncomeSource: otherIncomeBasis.source,
      taxRatePct: round(mcTaxRate * 100, 1), taxRateSource: taxBasis.source,
    },
    degraded: [
      ...(growthInfo.unusual
        ? [`Growth rate (${round(growth * 100, 0)}%) is well outside a typical range — likely a recovery from a collapsed base or a one-off`]
        : []),
      ...(thinDispersion ? ['Spread width from a thinner-than-usual sample of trading days'] : []),
    ],
    basisSummary: `Mid-cycle net margin ${round(midCycleMargin * 100, 1)}% (currently ${round(currentMargin * 100, 1)}%, ${cyclePosition}) · ${multipleLabel}`,
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
  const { years = 1, multipleOverride = null, growthOverride = null, peerBand = null, basis,
          incomeHistory = [], balanceHistory = [] } = opts
  const price = ratioResult?.price
  // ebitda/eps/netProfit/totalDebt/cash are all table-native — read off the
  // latest real row directly, falling back to ratioResult when the table
  // can't resolve one (see buildLenderEstimate's note above).
  const latestInc = latestRealRow(incomeHistory)
  const latestBal = latestRealRow(balanceHistory)
  const ebitda = activeValue(latestInc, 'ebitda', basis)?.value
    ?? ratioResult?.ebitda ?? ratioResult?.ratios?.ebitda?.value
  const ev = ratioResult?.ev ?? ratioResult?.ratios?.ev?.value
  const totalDebt = activeValue(latestBal, 'totalDebt', basis)?.value ?? ratioResult?.totalDebt ?? 0
  const cash = activeValue(latestBal, 'cash', basis)?.value ?? ratioResult?.cash ?? 0
  const netDebt = totalDebt - cash
  const eps = val(latestInc?.eps) ?? ratioResult?.eps
  const netProfit = val(latestInc?.netProfit) ?? ratioResult?.netProfit
  const shares = (netProfit > 0 && eps > 0) ? netProfit / eps : ratioResult?.shares
  if (!(ebitda > 0) || !(shares > 0) || !(price > 0)) return null

  const currentEvEbitda = ev > 0 ? ev / ebitda : null

  // Preferred: EBITDA as an OUTPUT of the shared driver-based waterfall
  // (buildWaterfallForecast) — the same forecast the P/E estimate uses, so
  // this doesn't independently re-derive EBITDA growth from its own
  // separate CAGR. Single year ahead only (years === 1); falls back to the
  // older EBITDA-CAGR-then-revenue-CAGR approach otherwise, or when the
  // waterfall declines (no margin history at all).
  let forwardEbitda = null, growthInfo = null
  if (growthOverride == null && years === 1) {
    const waterfall = buildWaterfallForecast(
      { reportedIncomeHistory: incomeHistory, balanceHistory, basis },
      { incomeHistory: opts.incomeHistory }
    )
    if (waterfall?.ebitda > 0) {
      forwardEbitda = waterfall.ebitda
      growthInfo = { growth: waterfall.drivers.growthPct / 100, unusual: false,
        label: `waterfall (${waterfall.drivers.ebitdaMarginPct}% EBITDA margin, ${waterfall.drivers.ebitdaMarginSource})` }
    }
  }
  if (forwardEbitda == null) {
    // EBITDA growth measured from reported EBITDA where the history carries
    // it, falling back to revenue growth — for a capital-intensive business
    // with a stable cost base the two track closely, and that substitution
    // is stated rather than silent. No default: without either, there is
    // no estimate.
    growthInfo = growthOverride != null
      ? { growth: growthOverride, label: (opts.overrideLabel || 'an applied revision') }
      : (seriesCagr(opts.incomeHistory, 'ebitda', 'EBITDA CAGR')
         ?? revenueCagr(opts.incomeHistory, { label: 'revenue CAGR (EBITDA history unavailable)' }))
    if (growthInfo?.growth == null) return null
    forwardEbitda = ebitda * Math.pow(1 + growthInfo.growth, years)
  }
  const growth = growthInfo.growth

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
  // The retained share is measured from this company's own FCF/EBITDA
  // conversion where available (what actually survived tax, interest and
  // capex last period) rather than an invented flat 35% — that number had no
  // stated derivation and applied identically to a near-zero-capex software
  // business and a heavy-capex manufacturer alike. Falls back to 35% (a
  // reasonable industrial-economy midpoint) only when FCF genuinely isn't
  // measurable. No clamp on the measured case: a real, differentiated
  // business can legitimately convert outside any asserted band (a
  // near-zero-capex software company above 90%, a heavy-capex one below
  // 10%), and forcing a real measured ratio into a guessed range replaces
  // real data with a guess — the same fix already applied to
  // justifiedMultiple.js's identical clamp this session.
  const payoutFrac = (ratioResult?.ratios?.dividendPayout?.value ?? 0) / 100
  const measuredEbitdaConversion = (ratioResult?.fcf > 0) ? ratioResult.fcf / ebitda : null
  const ebitdaConversion = measuredEbitdaConversion ?? 0.35
  const retainedCash = ebitda * ebitdaConversion * Math.max(0, 1 - payoutFrac) * years
  const forwardNetDebt = Math.max(0, netDebt - retainedCash)

  const toEquity = (m) => {
    const impliedEv = forwardEbitda * m
    return (impliedEv - forwardNetDebt) / shares
  }
  // Range width from how much this company's OWN multiple has actually varied.
  // Falls back to this stock's own price dispersion (needs only closes, not
  // paired EBITDA — clears where multipleSpread can't) rather than a flat
  // ±15%; declines (null, caller falls through to the generic chain) if
  // even that isn't measurable.
  let sp = multipleSpread(opts.priceHistory, opts.incomeHistory, 'ebitda')
  let thinSpread = !!sp?.thin
  if (!sp) {
    const dd = priceDispersion(opts.priceHistory)
    if (dd == null) return null
    sp = { lo: 1 - dd.half, hi: 1 + dd.half }
    thinSpread = dd.thin
  }
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
    // Exposed so a UI walkthrough can reproduce the actual EV→equity bridge
    // (EBITDA × multiple = enterprise value; minus net debt; ÷ shares =
    // per-share target) instead of a P/E-style single multiplication, which
    // is only valid for a per-share-equity metric like EPS or book value —
    // EBITDA is a company-level (enterprise) figure, not a per-share one.
    shares: round(shares),
    epsPath: 'EBITDA × EV/EBITDA, less net debt after a year of cash generation, ÷ shares',
    marginPct: null, marginLabel: 'EBITDA-based — net margin not used', marginSource: 'n/a',
    growth, growthPct: round(growth * 100, 1),
    growthSource: growthOverride != null ? 'revision' : 'cagr',
    growthLabel: growthInfo.label,
    dilutionPct: 0, dilutionLabel: 'not modelled',
    multiples: { low: round(multiple * sp.lo, 1), base: round(multiple, 1), high: round(multiple * sp.hi, 1) },
    multipleBasis, multipleLabel,
    target, upside,
    degraded: [
      ...(thinSpread ? ['Spread width from a thinner-than-usual sample of trading days'] : []),
      ...(growthInfo.unusual
        ? [`Growth rate (${round(growth * 100, 0)}%) is well outside a typical range — likely a recovery from a collapsed base or a one-off`]
        : []),
    ],
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
  const { years = 1, peerBand = null, multipleOverride = null, growthOverride = null,
          basis, incomeHistory = [], balanceHistory = [] } = opts
  const price = ratioResult?.price
  // revenue/totalDebt/cash are table-native, read off the latest real row
  // directly, falling back to ratioResult when the table can't resolve one
  // (see buildLenderEstimate's note above).
  const latestInc = latestRealRow(incomeHistory)
  const latestBal = latestRealRow(balanceHistory)
  const revenue = val(latestInc?.revenue) ?? ratioResult?.revenue
  const ev = ratioResult?.ev ?? ratioResult?.ratios?.ev?.value
  const totalDebt = activeValue(latestBal, 'totalDebt', basis)?.value ?? ratioResult?.totalDebt ?? 0
  const cash = activeValue(latestBal, 'cash', basis)?.value ?? ratioResult?.cash ?? 0
  const netDebt = totalDebt - cash
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
  //
  // Preferred: NetDebt_t = NetDebt_0 - FCFF_t, using the SAME driver-based
  // waterfall (buildWaterfallForecast) the standard/EV-EBITDA chains use —
  // cash-flow-based, not a proxy off the net-profit LOSS, which conflates the
  // accounting loss with the cash actually burned (D&A doesn't burn cash;
  // capex and working-capital changes burn cash the P&L loss doesn't show at
  // all). buildWaterfallForecast's share-count derivation (netProfit/EPS)
  // can't resolve for a loss-maker, but its EBITDA/EBIT/PBT/FCFF math doesn't
  // need shares — it degrades dilutedShares/eps to null rather than aborting,
  // so its fcff is still usable here even though this company has no EPS.
  // Falls back to the net-profit burn rate where the waterfall can't run at
  // all (no EBITDA-margin history) — flagged, not silent.
  const wf = buildWaterfallForecast(
    { reportedIncomeHistory: incomeHistory, balanceHistory, basis },
    { incomeHistory: opts.incomeHistory }
  )
  let forwardNetDebt, netDebtSource
  if (wf?.fcff != null && isFinite(wf.fcff)) {
    forwardNetDebt = netDebt - wf.fcff * years
    netDebtSource = 'cash-flow'
  } else {
    const npForBurn = val(latestInc?.netProfit) ?? netProfitOf(ratioResult)
    const burn = npForBurn < 0 ? Math.abs(npForBurn) * years : 0
    forwardNetDebt = netDebt + burn
    netDebtSource = 'loss-burn'
  }
  const toEquity = m => ((forwardRevenue * m) - forwardNetDebt) / shares

  // Same fallback chain as the other models: this stock's own measured
  // multiple spread, else its price dispersion, else decline rather than
  // assert a flat ±25%.
  let sp = multipleSpread(opts.priceHistory, opts.incomeHistory, 'revenue')
  let thinSpread = !!sp?.thin
  if (!sp) {
    const dd = priceDispersion(opts.priceHistory)
    if (dd == null) return null
    sp = { lo: 1 - dd.half, hi: 1 + dd.half }
    thinSpread = dd.thin
  }
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
    // Exposed so a UI walkthrough can reproduce the actual EV→equity bridge
    // (revenue × multiple = enterprise value; minus net debt; ÷ shares =
    // per-share target) instead of a P/E-style single multiplication —
    // revenue, like EBITDA, is a company-level figure, not per-share.
    revenue: round(revenue), forwardRevenue: round(forwardRevenue),
    netDebt: round(netDebt), forwardNetDebt: round(forwardNetDebt),
    shares: round(shares),
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
    degraded: [
      'No profit — valued on sales, which ignores whether they convert to cash',
      ...(growthInfo.unusual ? [`Growth rate (${round(growth * 100, 0)}%) is well outside a typical range — likely a recovery from a collapsed base or a one-off`] : []),
      ...(thinSpread ? ['Spread width from a thinner-than-usual sample of trading days'] : []),
      ...(netDebtSource === 'loss-burn' ? ['Net debt projected from the current-year loss run-rate — forecast free cash flow wasn\'t derivable (no EBITDA-margin history)'] : []),
    ],
    basisSummary: `Revenue ${round(forwardRevenue)} × ${round(multiple, 2)}× sales, less net debt `
      + `(${netDebtSource === 'cash-flow' ? 'evolved from forecast FCFF' : 'current loss run-rate'})`,
  }
}

const netProfitOf = rr => (rr?.netProfit ?? 0)

/**
 * Growth ladder: guidance → revenue CAGR over the user's chosen window → nothing.
 *
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
          overrideLabel = null, incomeHistory = [], basis } = opts
  const r = ratioResult?.ratios || {}
  const all = []

  // 1. Guidance, if entered. (An applied revision outranks this and is handled by
  //    the caller via growthOverride, so it never reaches here.)
  if (guidedGrowth != null && isFinite(guidedGrowth)) {
    all.push({ growth: guidedGrowth, source: 'guidance', rung: 'best',
               label: overrideLabel || `guidance${guidanceFiscalYear ? ` (${guidanceFiscalYear})` : ''}` })
  }
  // 2. The single dynamic CAGR — identical to every other consumer (via the
  // shared tableGrowthRate reader: full-period CAGR for reported, selected
  // method for normalized). Falls back to ratioResult's own revCagr when the
  // table lookup can't resolve one — the one caller this matters for is
  // snapshotRebuild.js's historical "as of" reconstruction, whose truncated
  // income slice has no materialized growth field of its own (that field
  // lives only on TODAY's latest row) and instead hand-reconstructs revCagr
  // onto its synthetic ratioResult for exactly that reason.
  const tableGrowth = tableGrowthRate({ incomeHistory, basis }, 'revenueGrowth', basis)
  const revCagrValue = tableGrowth.value ?? r.revCagr?.value ?? null
  const revCagrWindowYears = tableGrowth.windowYears ?? r.revCagrWindowYears?.value ?? null
  if (revCagrValue != null && isFinite(revCagrValue)) {
    // tableGrowthRate can hand back three genuinely different methods
    // (fullPeriodCagr for reported; medianYoY or recentMedianYoY for
    // normalized, whichever this ticker has selected) — this used to call
    // all three "CAGR" regardless, which is simply the wrong name for a
    // median-of-yearly-growth-rates figure (a real, different calculation,
    // not just a different window of the same one).
    const methodName = {
      fullPeriodCagr: 'revenue CAGR',
      medianYoY: 'median YoY revenue growth',
      recentMedianYoY: 'recent median YoY revenue growth',
    }[tableGrowth.method] || 'revenue CAGR'
    all.push({ growth: revCagrValue / 100, source: 'cagr', rung: 'fallback',
               label: revCagrWindowYears
                ? `${revCagrWindowYears}-yr ${methodName} (your window)`
                  : `${methodName} (your window)` })
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

// How far the measured rate is trusted, in either direction, before it's
// capped and disclosed — scaled by how many "ordinary" (non-one-off) years
// actually support it. Shares are inferred here as profit ÷ EPS, not read
// off a real reported share-count line, so there's no way to tell a genuine
// buyback/issuance apart from a stock split, a basic/diluted-count switch,
// or a one-off restatement except by how CONSISTENT the trend is across
// years — a thin trend gets a tight cap, a longer consistent one a looser
// one, rather than one flat number applied regardless of how much history
// actually backs it.
const DILUTION_CAP_BY_YEARS = { 2: 0.05, 4: 0.07, 6: 0.10 }
const capForYears = (n) => n >= 6 ? DILUTION_CAP_BY_YEARS[6] : n >= 4 ? DILUTION_CAP_BY_YEARS[4] : DILUTION_CAP_BY_YEARS[2]

/**
 * Dilution ladder: observed share-count trend → flat.
 * EPS is profit ÷ shares, and share counts drift — up from ESOPs/QIPs
 * (dilution, overstating EPS for anyone who ignores it), or down from a
 * sustained buyback (the reverse: EPS accretion a frozen count would miss).
 * Both directions are measured the same way; only the label differs.
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
  // No floor at 0: a sustained buyback program is a genuine negative trend,
  // not noise to be erased — flattening it to "no dilution" would credit a
  // frozen share count to a company that's actually shrinking one, understating
  // the EPS accretion buybacks produce. What guards against a THIN or noisy
  // trend being taken at face value is the cap below, not a one-sided floor.
  const rawRate = used.reduce((t, x) => t + x, 0) / used.length
  const cap = capForYears(used.length)
  const rate = Math.max(-cap, Math.min(cap, rawRate))
  const wasCapped = rate !== rawRate

  const excludedNote = excluded > 0 ? ` (${excluded} one-off issuance${excluded > 1 ? 's' : ''} excluded)` : ''
  const cappedNote = wasCapped
    ? ` — ${round(rawRate * 100, 1)}%/yr measured, capped at ${round(cap * 100, 1)}%/yr (limited history to confirm a sustained ${rawRate > 0 ? 'issuance' : 'buyback'} program)`
    : ''

  return {
    rate, source: 'observed', rung: 'good',
    excludedYears: excluded, capped: wasCapped, rawRate: round(rawRate * 100, 1),
    label: Math.abs(rate) > 0.001
      ? rate > 0
        ? `${round(rate * 100, 1)}%/yr dilution${excludedNote}${cappedNote}`
        : `${round(Math.abs(rate) * 100, 1)}%/yr buyback (EPS-accretive)${excludedNote}${cappedNote}`
      : 'no material change in share count',
  }
}

/**
 * The canonical earnings forecast — Revenue → EBITDA → EBIT → PBT →
 * NetProfit → EPS, one year (t+1) ahead — replacing the "revenue × net
 * margin" shortcut with a driver-based waterfall. Only the DRIVERS are
 * forecast (growth, EBITDA margin, D&A/revenue, net-interest/revenue,
 * other income, tax rate, diluted shares, capex/revenue, NWC/revenue);
 * every other line (EBITDA, EBIT, PBT, tax, net profit, EPS, FCFF) is a
 * calculated OUTPUT of those drivers, never independently assumed — so a
 * margin change is always traceable to which driver actually moved.
 *
 * data: {reportedIncomeHistory, balanceHistory, cashflowHistory, basis} —
 * the same shape every other table-native reader in this app takes.
 * opts.guided (optional): {growth, ebitdaMargin, daToRevenue,
 * netInterestToRevenue, taxRate, capexToRevenue, nwcToRevenue} — an
 * explicit override for any one driver (guidance, a user revision), same
 * "guided" rung every other ladder in this file already has. Diluted
 * shares reuse the existing buyback-aware resolveDilution() rather than
 * holding shares flat — that mechanism already measures and caps a real
 * trend from this company's own history; there's no reason to regress to a
 * frozen count just because it's now feeding a fuller earnings model.
 *
 * Returns null when there's no margin history to build from at all (same
 * "decline rather than fabricate" rule as every other estimate function
 * here) — the caller falls back to whatever it did before this existed.
 */
export function buildWaterfallForecast(data, opts = {}) {
  const basis = data?.basis
  const guided = opts.guided || {}
  const incomeHistory = (data?.reportedIncomeHistory || data?.incomeHistory || []).filter(x => !x?.synthetic)
  const latestInc = latestRealRow(incomeHistory)
  const revenue0 = val(activeValue(latestInc, 'revenue', basis))
  if (!(revenue0 > 0)) return null

  const growthInfo = tableGrowthRate(data, 'revenueGrowth', basis)
  const g = guided.growth ?? (growthInfo.value != null ? growthInfo.value / 100 : null)
  if (g == null) return null

  const ebitdaMarginBasis   = tableRatioBasis(data, 'ebitdaMargin', basis, { guided: guided.ebitdaMargin })
  if (ebitdaMarginBasis.value == null) return null   // no margin history — nothing to build a waterfall from

  const daBasis             = tableRatioBasis(data, 'daToRevenue', basis, { guided: guided.daToRevenue })
  const interestBasis       = tableRatioBasis(data, 'netInterestToRevenue', basis, { guided: guided.netInterestToRevenue })
  const otherIncomeBasis    = otherIncomeForecastBasis(data, basis)
  // Tax rate only from years the concept is even meaningful in — a
  // negative-PBT year's tax/PBT isn't a real rate, it's a sign-flipped
  // artefact of dividing by a negative number.
  const taxBasis = tableRatioBasis(data, 'effectiveTaxRate', basis, {
    guided: guided.taxRate,
    filterYear: p => (activeValue(p.row, 'profitBeforeTax', basis)?.value ?? -1) > 0,
  })
  const capexBasis          = tableRatioBasis(data, 'capexToRevenue', basis, { guided: guided.capexToRevenue })
  const nwcBasis            = tableRatioBasis(data, 'nwcToRevenue', basis, { guided: guided.nwcToRevenue })

  const revenue1 = revenue0 * (1 + g)
  const ebitda1  = revenue1 * (ebitdaMarginBasis.value / 100)
  const da1      = daBasis.value != null ? revenue1 * (daBasis.value / 100) : 0
  const ebit1    = ebitda1 - da1
  const netInterest1 = interestBasis.value != null ? revenue1 * (interestBasis.value / 100) : 0
  const otherIncome1 = revenue1 * (otherIncomeBasis.value ?? 0)
  const pbt1 = ebit1 - netInterest1 + otherIncome1

  // Negative PBT: tax is set to zero in this simplified model rather than
  // modelling a tax benefit — a deliberate, disclosed simplification, not
  // an oversight.
  let taxRate = taxBasis.value != null ? Math.max(0, Math.min(1, taxBasis.value / 100)) : 0
  const tax1 = pbt1 > 0 ? pbt1 * taxRate : 0
  const netProfit1 = pbt1 - tax1

  const dilution = resolveDilution(opts.incomeHistory || incomeHistory)
  const latestNp  = val(activeValue(latestInc, 'netProfit', basis))
  const latestEps = val(activeValue(latestInc, 'eps', basis))
  const sharesNow = (latestNp > 0 && latestEps > 0) ? latestNp / latestEps : null
  // A loss-making company (netProfit and EPS both <= 0) has no derivable
  // share count here, but EBITDA/EBIT/PBT/FCFF below don't depend on one —
  // degrading only dilutedShares/eps to null (instead of aborting the whole
  // forecast) lets a company-total consumer (buildEvSalesEstimate's net-debt
  // evolution) use the rest of the waterfall where a per-share consumer can't.
  const shares1 = sharesNow > 0 ? sharesNow * (1 + dilution.rate) : null
  const eps1 = shares1 > 0 ? netProfit1 / shares1 : null
  // Explicit, not inferred from eps/dilutedShares being null: a caller that
  // only checks `.eps > 0` (the standard chain, EV/EBITDA) already treats
  // null correctly as "can't use this for per-share", but a caller reading
  // `.fcff`/`.ebitda` directly (EV/Sales's net-debt evolution) has no other
  // way to tell "operating/cash-flow outputs are real, only shares failed"
  // apart from "the whole forecast failed" (which instead returns null
  // above, before any of this runs) — same "never silently degrade" rule
  // the rest of this file's `degraded` arrays exist to enforce, applied to
  // this function's own partial-success case.
  const forecastStatus = shares1 > 0 ? 'full' : 'partial'
  const degraded = shares1 > 0 ? [] : [
    'Share count unavailable (netProfit/EPS both <= 0, typically a loss-making company) — dilutedShares/eps are null; operating and cash-flow outputs (EBITDA, EBIT, PBT, FCFF) are unaffected',
  ]

  // FCFF bridge — NWC forecast as a LEVEL first (revenue × ratio), then
  // differenced against the latest actual balance-sheet NWC. Forecasting
  // ΔNWC directly as revenue × ratio would treat the whole forecast NWC
  // level as if it were the year's change — a real error, not a style
  // choice, since it has no relationship to how much working capital
  // actually needs funding that year.
  const latestBal = latestRealRow((data?.balanceHistory || []).filter(x => !x?.synthetic))
  const nwc0 = val(activeValue(latestBal, 'nwc', basis)) ?? 0
  const capex1 = capexBasis.value != null ? revenue1 * (capexBasis.value / 100) : 0
  const nwc1   = nwcBasis.value != null ? revenue1 * (nwcBasis.value / 100) : nwc0
  const deltaNwc1 = nwc1 - nwc0
  const fcff1 = ebit1 * (1 - taxRate) + da1 - capex1 - deltaNwc1

  return {
    revenue: revenue1, ebitda: ebitda1, da: da1, ebit: ebit1,
    netInterest: netInterest1, otherIncome: otherIncome1, pbt: pbt1,
    taxRate, tax: tax1, netProfit: netProfit1,
    dilutedShares: shares1, eps: eps1,
    capex: capex1, nwc: nwc1, deltaNwc: deltaNwc1, fcff: fcff1,
    forecastStatus, degraded,
    drivers: {
      growthPct: round(g * 100, 1),
      ebitdaMarginPct: round(ebitdaMarginBasis.value, 1), ebitdaMarginSource: ebitdaMarginBasis.source,
      daToRevenuePct: daBasis.value != null ? round(daBasis.value, 1) : null,
      netInterestToRevenuePct: interestBasis.value != null ? round(interestBasis.value, 1) : null,
      otherIncomeToRevenuePct: otherIncomeBasis.value ? round(otherIncomeBasis.value * 100, 2) : 0,
      otherIncomeSource: otherIncomeBasis.source,
      taxRatePct: round(taxRate * 100, 1), taxRateSource: taxBasis.source,
      dilutionPct: round(dilution.rate * 100, 1), dilutionLabel: dilution.label,
      capexToRevenuePct: capexBasis.value != null ? round(capexBasis.value, 1) : null,
      nwcToRevenuePct: nwcBasis.value != null ? round(nwcBasis.value, 1) : null,
    },
  }
}

/**
 * Sanity check, lenders especially: growth needs capital. A business can only
 * self-fund g ≈ ROE × retention. Guiding well above that isn't impossible — it
 * means raising equity or leverage — but it should be SAID rather than absorbed
 * silently into a price target.
 */
export function financeabilityNote(ratioResult, growth, opts = {}) {
  const { incomeHistory = [], basis } = opts
  const incRowF = latestRealRow(incomeHistory)
  // roe/payout are table-native — read off the latest real row directly,
  // falling back to ratioResult when the table can't resolve one (see
  // buildLenderEstimate's note above).
  const roe = activeValue(incRowF, 'roe', basis)?.value ?? ratioResult?.ratios?.roe?.value
  if (roe == null || growth == null) return null
  const payout = activeValue(incRowF, 'dividendPayout', basis)?.value ?? ratioResult?.ratios?.dividendPayout?.value
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
  //
  // Tests the actual mathematical cause directly — (required return − growth)
  // thin relative to the required return itself, the single-stage Gordon-growth
  // denominator's real degeneracy condition — rather than four independently-
  // guessed ceiling values (one per multiple type) that were each standing in
  // for the same underlying test. Only applies to the single-stage form:
  // twoStage forms fade to the market's terminal growth rate (2.5-5%) well below the required
  // return by construction (justifiedMultiple.js requires r > terminalG to even
  // run), so they don't have this instability at all.
  const rr_ = jm.requiredReturn?.r
  const gapFraction = (rr_ > 0) ? (rr_ - jm.growth.g) / rr_ : null
  if (chosen && !jm.twoStage && gapFraction != null && gapFraction < 0.1) {
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

  // eps/ebitda/revenue are table-native — read off the latest real row
  // directly (opts.incomeHistory/basis, same as everywhere else in this
  // file), falling back to ratioResult when the table can't resolve one.
  // No balanceHistory reaches this function's callers, so netDebt/totalDebt/
  // cash/bookPerShare below stay on ratioResult.
  const latestIncJ = latestRealRow(opts.incomeHistory || [])
  const epsT = activeValue(latestIncJ, 'eps', opts.basis)?.value ?? ratioResult?.eps
  const ebitdaT = activeValue(latestIncJ, 'ebitda', opts.basis)?.value ?? ratioResult?.ebitda ?? R.ebitda?.value
  const revenueT = activeValue(latestIncJ, 'revenue', opts.basis)?.value ?? ratioResult?.revenue

  // The quantity the multiple attaches to, projected one year.
  let base, baseLabel
  switch (form) {
    case 'pe':       base = epsT; baseLabel = 'EPS'; break
    case 'pb':       base = R.bookPerShare?.value; baseLabel = 'book per share'; break
    case 'evEbitda': base = ebitdaT; baseLabel = 'EBITDA'; break
    case 'evSales':  base = revenueT; baseLabel = 'revenue'; break
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

  // A justified multiple (payout/(r-g), and its EV/EBITDA, EV/Sales analogs)
  // is a single deterministic formula output for one (r, g, payout) — it has
  // no natural low/high the way a peer comparable's real dispersion does, or
  // a DCF's genuinely different bear/base/bull scenarios do. This used to
  // manufacture one anyway: perturb r by ±1pt, keep the result only inside an
  // unexplained 0.4-2.5x window of the base, substitute a different
  // unexplained ±15% when it didn't. Two arbitrary numbers standing in for
  // what was never a real range. The formula's actual sensitivity is already
  // disclosed properly below (`steps`, states r/g/payout explicitly) — a
  // manufactured band never added anything a fabricated number doesn't.
  const rr = jm.requiredReturn

  return {
    ok: true, model: 'justified', form,
    kind: 'valuation',              // not a projection — no horizon
    createdAt: Date.now(),
    priceAtEstimate: round(price),
    multiples: { base: chosen.multiple },
    multipleBasis: 'justified',
    multipleLabel: chosen.label,
    multipleSteps: chosen.steps,
    tier: chosen.tier,
    availableForms: Object.keys(jm.forms),
    formLabels: Object.fromEntries(Object.entries(jm.forms).map(([k, f]) => [k, f.label])),
    growth: g, growthPct: jm.growth.gPct,
    growthSource: 'roe-retention',
    growthLabel: `${round(jm.growth.roe, 1)}% ROE (${jm.growth.roeSource}) × ${round(jm.growth.retention * 100, 0)}% retained`,
    requiredReturnPct: round(rr.r * 100, 1),
    requiredReturnLabel: rr.label,
    twoStage: jm.twoStage,
    base: round(base), baseLabel,
    target: { base: round(mid) },
    upside: price > 0 ? { base: round(((mid - price) / price) * 100, 1) } : null,
    degraded: [
      ...(rr.betaAssumed ? ['Beta unavailable — assumed 1.0'] : []),
      // capmCostOfEquity() already computes this (it's the same CAPM call
      // the DCF's WACC uses), but nothing previously carried it through to
      // Justified Multiples — an unusual beta (either direction) thins or
      // widens (r - g) and every form here divides by that gap, so it
      // deserves to be visible here specifically, not only on the DCF line.
      ...(rr.betaFlag ? [rr.betaFlag] : []),
    ],
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
    priceHistory = [], incomeHistory: rawIncomeHistory = [], balanceHistory: rawBalanceHistory = [],
    peerBand = null, peerWeight = 0, years = 1, basis: normBasis = 'reported',
  } = opts
  // Resolved once, here — see resolveHistoryBasis's own comment. Everything
  // below (the sector builders, resolveGrowthBasis, resolveMarginBasis,
  // resolveDilution, targetMultiple) reads THESE, not opts.incomeHistory/
  // balanceHistory directly, so the reported/normalized toggle is honored
  // no matter which method this ticker ends up using.
  const { income: incomeHistory, balance: balanceHistory } = resolveHistoryBasis(rawIncomeHistory, rawBalanceHistory, normBasis)
  const resolvedOpts = { ...opts, incomeHistory, balanceHistory }

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

  // isFinancialSector is a genuine strong routing rule, not a convenience
  // label — for a bank/NBFC/insurer, book value and ROE are the central
  // economic drivers, debt/interest mean something structurally different,
  // and the balance sheet IS the operating model, so enterprise-value/
  // EBITDA-FCFF logic (the rest of this chain) is generally not meaningful
  // for it at all. Reused below to make sure a FAILED lender build doesn't
  // silently fall through into that operating-company logic anyway.
  const isFinancialSector = st === 'bank' || st === 'nbfc' || st === 'insurance' || st === 'financial'
  if (isFinancialSector) {
    const lender = buildLenderEstimate(ratioResult, resolvedOpts)
    if (lender) return lender
  }

  // Data-driven, independent of the sector-keyword 'cyclical' flag below —
  // catches a company whose OWN earnings history makes P/E unreliable
  // (frequent losses, too little history) even when its sector/industry
  // name isn't on the keyword list. See assessPeSuitability's own doc
  // comment for why this is measured from the data rather than inferred
  // from the sector string.
  const peDiagnostics = measurePeDiagnostics(resolvedOpts.incomeHistory, normBasis, resolvedOpts.priceHistory)
  const peSuitability = assessPeSuitability(peDiagnostics)

  // Sector tags are a provisional classification — "what kinds of models
  // might be relevant" — not proof of which one applies. Only genuine
  // recurring-cycle evidence (2+ completed collapse-and-recovery cycles,
  // measured from THIS company's own history) sends it to the through-
  // cycle treatment; the 'cyclical' tag never forces that on its own any
  // more, not even in an otherwise ambiguous case (one downturn and
  // recovery is exactly as consistent with a one-off shock as with genuine
  // cyclicality — insufficient either way to override what the data
  // doesn't establish). buildCyclicalEstimate takes a FULL-HISTORY median
  // on the assumption the entire history is one undifferentiated cycle; a
  // turnaround (early losses, a real fix, now sustained profit) doesn't fit
  // that assumption, and averaging its pre-fix years back in would drag the
  // estimate toward a margin the business has already left behind. The tag
  // is retained purely as context for whichever model the data actually
  // supports (see the methodCaveat branch below), never as the deciding
  // vote.
  if (peSuitability.recurringCyclicalEvidence) {
    const cyc = buildCyclicalEstimate(ratioResult, resolvedOpts)
    if (cyc) {
      return st === 'cyclical' ? cyc : {
        ...cyc,
        degraded: [...cyc.degraded, ...peSuitability.reasons.map(r => `Routed to through-cycle treatment: ${r}`)],
      }
    }
  }

  // EBITDA suitability — measured unconditionally, once, mirroring
  // peSuitability's own measure/classify split. A capital-intensive/yield
  // tag says "EV/EBITDA might be the right lens for this business"; this
  // is what actually establishes whether it is for THIS company. Skipped
  // entirely for financial-sector companies — enterprise-value/EBITDA-FCFF
  // logic doesn't apply to a business whose balance sheet IS the operating
  // model, whether or not its lender model happened to build successfully.
  const ebitdaDiagnostics = !isFinancialSector
    ? measureEbitdaDiagnostics(resolvedOpts.incomeHistory, normBasis, resolvedOpts.balanceHistory)
    : null
  const ebitdaSuitability = ebitdaDiagnostics ? assessEbitdaSuitability(ebitdaDiagnostics) : null
  const capitalIntensiveTag = st === 'capital-intensive' || st === 'yield'
  const peWeak = peSuitability.suitability === 'unsuitable' || peSuitability.suitability === 'insufficient_history'

  // EV/EBITDA is tried — and can WIN over an otherwise-suitable P/E — in
  // two distinct circumstances, both requiring the data to actually
  // establish it, never the tag alone:
  //   (a) tag-informed preference: capital-intensive/yield business with
  //       genuinely usable EBITDA — depreciation schedules and financing
  //       structure can distort P/E comparability even when the P/E
  //       itself is technically computable, so a suitable P/E doesn't by
  //       itself rule this out.
  //   (b) rescue: P/E is unsuitable/insufficient_history for ANY company,
  //       regardless of sector tag — EV/EBITDA is a genuine alternative
  //       basis, tried before falling further.
  const preferEbitda = ebitdaSuitability?.suitability === 'suitable' && (capitalIntensiveTag || peWeak)
  if (preferEbitda) {
    const ev = buildEvEbitdaEstimate(ratioResult, resolvedOpts)
    if (ev) {
      const caveats = []
      if (peWeak) {
        caveats.push(`P/E-based valuation is on weak footing for this stock: ${peSuitability.reasons.join(' ')} Valued on EV/EBITDA instead.`)
      } else if (capitalIntensiveTag) {
        caveats.push(`Valued on EV/EBITDA rather than P/E: a capital-intensive/yield business with genuinely usable EBITDA, where depreciation and financing structure can distort P/E comparability even though its own P/E is technically usable.`)
      }
      return caveats.length ? { ...ev, degraded: [...ev.degraded, ...caveats] } : ev
    }
  }

  // P/E is unsuitable/insufficient_history AND EV/EBITDA either wasn't
  // eligible, wasn't preferred, or failed to build — revenue-based
  // valuation is the next, weaker alternative (needs no profit line at
  // all, so it works regardless of EPS sign). If even that can't run,
  // nothing here is adequately supported by the data — an explicit
  // insufficient-data result is more honest than forcing a caveated P/E
  // number the way this used to, back when EV/EBITDA wasn't a real
  // alternative to fall to first.
  if (peWeak && !isFinancialSector) {
    const sales = buildEvSalesEstimate(ratioResult, resolvedOpts)
    if (sales) {
      const ebitdaNote = ebitdaSuitability && ebitdaSuitability.suitability !== 'suitable' ? ' EV/EBITDA was also not usable.' : ''
      return { ...sales, degraded: [...sales.degraded,
        `P/E-based valuation is on weak footing for this stock: ${peSuitability.reasons.join(' ')}${ebitdaNote}`] }
    }
    return blank(
      `No valuation model is adequately supported by this company's data: ${peSuitability.reasons.length ? peSuitability.reasons.join(' ') : 'too little reliable history to assess.'}`,
      { price: ratioResult?.price }
    )
  }

  // Realty and holding companies need NAV or stake data the app doesn't hold.
  // Rather than produce a number from a method that doesn't apply, they get the
  // standard chain WITH the mismatch stated — an estimate carrying its own
  // caveat is more useful than either silence or false confidence.
  const methodCaveat = (st === 'realty')
    ? 'Real estate is normally valued on the net asset value of the land bank; this is an earnings-based approximation.'
    : (st === 'holding')
    ? 'A holding company is normally valued as the sum of its stakes less a discount; this is an earnings-based approximation.'
    // The financial-sector tag couldn't route to the lender model (it
    // failed — missing payout history, most likely) and this company is
    // still being valued here on the operating-company chain below, which
    // book-value/ROE-driven businesses don't really fit either. Stated
    // rather than left looking like an ordinary earnings-based valuation.
    : isFinancialSector
    ? `Lender-specific valuation (book value compounding at ROE × retention) couldn't be built for this financial company — this is an earnings-based approximation instead, which doesn't reflect how banks/NBFCs/insurers are normally valued.`
    // The sector says cyclical, but recurring-cycle evidence wasn't
    // established (handled above — the tag never forces this model any
    // more, in any case) — stated rather than left looking like an
    // unremarkable standard valuation.
    : (st === 'cyclical' && !peSuitability.recurringCyclicalEvidence)
    ? `This sector is often cyclical, but this company's own earnings history doesn't establish a recurring cyclical pattern (${peDiagnostics.profitableYears} of ${peDiagnostics.totalYears} years profitable, ${peDiagnostics.cycleCount} completed collapse-and-recovery cycle${peDiagnostics.cycleCount === 1 ? '' : 's'} on record) — valued on its standard earnings profile instead of a through-cycle basis.`
    // 'unsuitable'/'insufficient_history' (peWeak) is handled entirely
    // above now (EV/EBITDA rescue -> EV/Sales rescue -> explicit decline)
    // and never reaches this point — only 'questionable' still runs the
    // standard chain, flagged rather than silently degraded.
    : (peSuitability.suitability === 'questionable')
    ? `P/E-based valuation is on weaker footing for this stock: ${peSuitability.reasons.join(' ')}`
    : null

  // No positive earnings, but P/E suitability wasn't weak overall (e.g. a
  // mostly-profitable history whose CURRENT year happens to be a loss) —
  // the peWeak cascade above never fired, so this is the one remaining
  // case needing its own fallback. Revenue-based valuation needs no
  // profit line at all. Excludes financial-sector companies, same
  // reasoning as the peWeak branch above.
  if (!(ratioResult?.eps > 0) && !isFinancialSector) {
    const sales = buildEvSalesEstimate(ratioResult, resolvedOpts)
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
        ...resolvedOpts, guidedGrowth, guidanceFiscalYear, guidanceExpired })
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
  // Preferred: the full driver-based waterfall (Revenue → EBITDA → EBIT →
  // PBT → NetProfit → EPS, buildWaterfallForecast) — only DRIVERS are
  // forecast, every other line is a calculated output, so a margin move is
  // traceable to what actually changed (operating profitability, D&A,
  // interest, tax) instead of one undifferentiated net-margin number
  // absorbing all of it. Single year ahead only for now (years === 1) —
  // the multi-year convergence path is a separate, deliberately deferred
  // piece; for any other horizon this falls through to the older paths
  // below unchanged.
  //
  // Falls back to plain revenue × margin ÷ shares when the waterfall
  // declines (e.g. no EBITDA-margin history at all), then to compounding
  // EPS directly (the old margins-frozen behaviour) as the last resort —
  // each rung flagged, never silently swapped for a weaker one.
  const g   = growthBasis.growth
  const dil = Math.pow(1 + dilution.rate, years)
  let forwardEps = null, epsPath, projRevenue = null, projProfit = null
  let waterfall = null

  if (years === 1) {
    waterfall = buildWaterfallForecast(
      { reportedIncomeHistory: incomeHistory, balanceHistory, basis: normBasis },
      { guided: opts.guidedWaterfall, incomeHistory: opts.incomeHistory }
    )
    if (waterfall && waterfall.eps > 0) {
      forwardEps = waterfall.eps
      projRevenue = waterfall.revenue
      projProfit = waterfall.netProfit
      epsPath = 'waterfall: revenue → EBITDA → EBIT → PBT → net profit ÷ shares'
    }
  }

  if (forwardEps == null && revenue > 0 && marginBasis.margin != null) {
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
  // ROE: the same shared answer (resolveAnnualRoe, formulas.js) and the same
  // quarterly-preference layer (determineROEStart, justifiedMultiple.js)
  // buildLenderEstimate/justifiedMultiples use, rather than a fourth
  // independent 3-year ladder — one factual "what is this company's ROE"
  // question, same answer regardless of which method is asking.
  let forwardRoeValue = resolveAnnualRoe({ incomeHistory, balanceHistory, basis: normBasis, ratioResult }).value
  if (forwardRoeValue != null) {
    const started = determineROEStart({
      data: { reportedIncomeHistory: incomeHistory, quarterlyHistory: opts.quarterlyHistory || [] },
      basis: normBasis, fallbackRoe: forwardRoeValue, latestBalRow: latestRealRow(balanceHistory),
    })
    if (started.source !== '3-year annual median') forwardRoeValue = started.roe
  }
  const forwardRoeBasis = { value: forwardRoeValue }
  const fitted = targetMultiple({
    basis: 'pe', priceHistory, incomeHistory, balanceHistory,
    // Forward expectation. Defensible over a one-year horizon — ROE is far
    // stickier than earnings — but it IS an assumption of no change, and it
    // belongs in the working rather than buried here.
    forwardRoe: forwardRoeBasis.value ?? ratioResult?.ratios?.roe?.value ?? null,
    forwardGrowth: growthBasis.growth != null ? growthBasis.growth * 100 : null,
    peerBand,
    peerWeight,
  })

  // Same basis (reported, or reported-with-normalized-years-merged-in) as
  // the projection this band is applied to. See forwardPeBand's docblock.
  // conditionalFilter runs the SAME call through the comparable-regime
  // filter too (own.conditionalOwn) — years whose forward growth/ROE
  // actually resemble what's being forecast, not every year the stock has
  // ever traded through regardless of what regime it was in at the time.
  const ownRaw = forwardPeBand(priceHistory, incomeHistory, {
    normBasis, balanceHistory,
    conditionalFilter: (g != null && forwardRoeBasis.value != null)
      ? { forecastGrowth: g, forecastRoe: forwardRoeBasis.value } : null,
  })
  const bandReason = ownRaw?.insufficient ? ownRaw.reason : null
  let own = ownRaw?.insufficient ? null : ownRaw
  // The unconditioned band, kept for display regardless of which tier below
  // actually wins the forward range — historical evidence, never silently
  // reused AS the forward range itself. See the conditionalOwn tier below.
  const historicalContext = own
    ? { low: own.low, median: own.median, high: own.high, spanYears: own.spanYears,
        excludedLossYears: own.excludedLossYears, thin: own.thin }
    : null

  // A fallback (too few peers passed financial screening — see peerBands.js's
  // screenedPeerBand) must never read like a clean screened result — this is
  // the exact disclosure gap that let a loss-making or wrong-scale peer fully
  // drive this multiple with no visible sign anything was off.
  const peerScreeningNote = pb => pb?.screeningMode === 'fallback_all_confirmed'
    ? ` (screening fallback: ${pb.warning || 'fewer than 3 eligible peers, all confirmed peers used'})`
    : pb?.screeningMode === 'eligible_only' ? ` (${pb.count} screened peer${pb.count === 1 ? '' : 's'})` : ''

  // The ONE blend mechanism every own-history rung below uses now — so 0%
  // peer weight means zero peer influence in every fallback, not just the
  // regression rung that used to be the only place this was honored. At
  // weight 0 with `own` available: pure own, untouched. At weight 1: pure
  // peer. In between: base blended linearly; the spread is blended as a
  // RATIO around the new base (own's own low/high ÷ its own base, blended
  // against peer's low/high ÷ peer's own median) — same convention
  // targetMultiple.js's regression path already uses for its own peer
  // blend, not peer's absolute low/high pasted onto a different center.
  // Returns null when there is genuinely nothing to show (no own answer,
  // and weight is 0 or there's no peer band either) — the caller is
  // expected to fall through to the next rung, not treat null as a value.
  const blendWithPeers = (own, weight) => {
    const w = Math.max(0, Math.min(1, weight ?? 0))
    const hasPeer = peerBand?.median > 0
    const hasOwn = own?.base > 0
    if (!hasOwn && !hasPeer) return null
    if (!hasPeer || w <= 0) return hasOwn ? own : null
    if (!hasOwn) return null   // nothing to blend FROM even though weight > 0 — handled per-rung below, not silently defaulted to pure peer here
    const base = (1 - w) * own.base + w * peerBand.median
    const ownLo = own.low / own.base, ownHi = own.high / own.base
    const peerLo = peerBand.low / peerBand.median, peerHi = peerBand.high / peerBand.median
    const lo = (1 - w) * ownLo + w * peerLo, hi = (1 - w) * ownHi + w * peerHi
    return { low: round(base * lo, 1), base: round(base, 1), high: round(base * hi, 1) }
  }

  let multiples, multipleBasis, multipleLabel, thinMultiple = false, divergesFromCurrent = false
  // The own-history multiple BEFORE any peer blend — captured inside
  // whichever rung actually fires, so the return value below can show own,
  // peer, and blended figures side by side instead of only the final
  // blended number. Without this there's no way to see WHAT the blend
  // actually did — e.g. "peers pushed this from 65x to 95x" is invisible if
  // only the post-blend 95x is ever shown.
  let ownMultipleUnblended = null
  if (multipleOverride != null && multipleOverride > 0) {
    const c = multipleOverride
    // Keep whatever spread the measured band had, so a re-rating moves the
    // CENTRE of the range without also pretending the future got more certain.
    // If neither the band nor price dispersion can supply one, decline
    // rather than dereference a null spread (own && !priceHistory produced a
    // real crash here — the override is real, but there is nothing to size
    // a range around it with).
    const dd = own && own.median > 0 ? null : priceDispersion(priceHistory)
    const spread = own && own.median > 0
      ? { lo: own.low / own.median, hi: own.high / own.median }
      : dd != null ? { lo: 1 - dd.half, hi: 1 + dd.half } : null
    if (!spread) {
      return blank(
        'You set a multiple, but there is no measured band and no price history to size a range around it.',
        { price })
    }
    thinMultiple = own && own.median > 0 ? !!own.thin : !!dd?.thin
    multiples = { low: round(c * spread.lo, 1), base: round(c, 1), high: round(c * spread.hi, 1) }
    multipleBasis = 'revision'
    multipleLabel = `your re-rating (${round(c, 1)}×)`
  } else if (fitted && fitted.source === 'fitted') {
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'fitted'
    thinMultiple = !!fitted.thin
    multipleLabel = `${fitted.anchor}× historical anchor, adjusted for returns and growth`
    fittedSteps = fitted.steps
  } else if (own?.conditionalOwn?.confidence === 'usable' || own?.conditionalOwn?.confidence === 'weak') {
    // Comparable-regime band: years whose forward growth/ROE actually
    // resemble what's being forecast, not every year this stock has ever
    // traded through regardless of regime (a near-zero-earnings-base year,
    // a crisis-year collapse, a structurally different business). See
    // forwardPeBand's own conditionalOwn comment for the full mechanism.
    //
    // Both 'usable' (5+ years) and 'weak' (3-4) land here now and blend with
    // any peer band by the user's own peerWeight — dropped the old rule
    // where 'weak' automatically deferred to peers outright whenever a peer
    // band existed at all, regardless of the slider. That rule meant 0%
    // peer weight was never actually honored for a 'weak' reading: the
    // slider was overridden by a hard-coded preference. The confidence
    // difference still shows up as a caveat, not as a silent override.
    const co = own.conditionalOwn
    const ownM = { low: co.low, base: co.median, high: co.high }
    ownMultipleUnblended = ownM
    const blended = blendWithPeers(ownM, peerWeight)
    multiples = blended || ownM
    multipleBasis = 'conditional-own'
    thinMultiple = co.confidence === 'weak'
    const blendNote = peerWeight > 0 && peerBand?.median > 0
      ? ` — blended ${round(peerWeight * 100, 0)}% toward peer multiples${peerScreeningNote(peerBand)}` : ''
    multipleLabel = `comparable-regime forward P/E — ${co.observationsRetained} of ${co.observationsConsidered} years` +
      ` matched this stock's own forecast growth/ROE closely enough to use` +
      (co.confidence === 'weak' ? ' (weak support — few matching years)' : '') + blendNote
    if (fitted?.steps?.length) {
      fittedSteps = [
        'A regression-based adjustment (this stock\'s own ROE/growth vs. its multiple) was tried but not used — a comparable-regime historical band is shown instead:',
        ...fitted.steps,
      ]
    }
  } else if (fitted?.multiple > 0 && fitted.source === 'historical-median') {
    // fitted.multiple (targetMultiple()'s own plain median, same-year
    // convention) — a legitimate own-history answer that a real peer
    // distribution should be BLENDED against, by the user's actual weight,
    // not skipped outright just because a peer band happens to exist (that
    // was the previous behavior: a standalone peer-only rung was checked
    // BEFORE this one, so this branch could only ever fire when no peer
    // band existed at all — the plain historical median never got a chance
    // to compete with, or blend against, a peer distribution).
    //
    // Own's own range is still sized the same way as before blending
    // applies: price dispersion preferred over the raw unconditioned
    // historical spread, which this whole ladder exists to stop treating as
    // a forward range on its own.
    const dd = priceDispersion(priceHistory)
    const ownM = dd != null
      ? { low: round(fitted.multiple * (1 - dd.half), 1), base: fitted.multiple, high: round(fitted.multiple * (1 + dd.half), 1) }
      : { low: fitted.low, base: fitted.multiple, high: fitted.high }
    const ownRangeSource = dd != null ? 'dispersion' : 'unconditioned'
    ownMultipleUnblended = ownM
    multiples = blendWithPeers(ownM, peerWeight) || ownM
    multipleBasis = 'historical-median'
    thinMultiple = dd != null ? dd.thin : !!fitted.thin
    const blendNote = peerWeight > 0 && peerBand?.median > 0
      ? ` — blended ${round(peerWeight * 100, 0)}% toward peer multiples${peerScreeningNote(peerBand)}` : ''
    multipleLabel = `its own median multiple over ${fitted.observations} years` + (
      ownRangeSource === 'dispersion' ? ' — range from this stock\'s own price dispersion'
      : ' — range is this stock\'s full historical spread (no price dispersion available to narrow it)'
    ) + blendNote
    fittedSteps = fitted.steps
  } else if (fitted?.multiple > 0 && fitted.source === 'peers' && peerWeight > 0) {
    // targetMultiple() falls back to peers itself when this stock has fewer
    // than 3 years of matched price/earnings history (too recently listed to
    // measure a real band of its own) — there is no "own" side to blend
    // against here at all, so any nonzero weight means use it fully (a
    // fractional blend against nothing isn't a meaningful concept); exactly
    // 0% correctly falls through instead of forcing a peer-only answer
    // against an explicit "no peer influence" setting.
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'peer'
    multipleLabel = `peer multiples — only ${fitted.observations} year${fitted.observations === 1 ? '' : 's'} of this stock's own trading history, too little to measure its own band` + peerScreeningNote(peerBand)
    fittedSteps = fitted.steps
  } else if (currentPe > 0) {
    const c = currentPe
    const dd = priceDispersion(priceHistory)
    if (dd == null) {
      return blank(
        'No price history for this stock, so there is no way to measure how wide a range should be. ' +
        'The fundamentals-based estimate does not need price history and is shown instead.',
        { price })
    }
    const sp = dd.half
    thinMultiple = dd.thin
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

  // A winning multiple sitting far from today's actual P/E (LIC: band 60-75x
  // against a stock trading near 14x) isn't discarded — "the range disagrees
  // with today's price" is exactly what a genuine re-rating looks like, not
  // only what a bad sample looks like, and rerating.js exists specifically
  // to make that distinction. Checked generically against whichever tier
  // won ('current'/'revision' are anchored to currentPe by construction, so
  // divergence from it is meaningless for those two).
  if (multipleBasis !== 'current' && multipleBasis !== 'revision' && currentPe > 0 && multiples.base > 0) {
    const ratio = multiples.base / currentPe
    divergesFromCurrent = ratio > 2.5 || ratio < 0.4
  }

  // A band has to actually be one — DEGENERATE means the percentiles have
  // collapsed onto each other, so the "range" is one number with noise
  // beside it, which is a real structural problem (n=2-style degeneracy),
  // not a judgment call. "Effectively equal" rather than strictly equal: a
  // low of 79.99 against a base of 80 passes a `>=` test while being the
  // same number, and renders as a range whose lower half is meaningless.
  // Anything inside 3% counts as collapsed.
  //
  // A high/low ratio beyond ~2.5× used to be discarded here too
  // (IMPLAUSIBLE — "two different regimes averaged together," Trent's
  // 59-171x cited as the motivating case) — but a wide ratio is also
  // exactly what a genuine re-rating looks like, and discarding it here
  // never gave rerating.js (built for distinguishing the two) a chance to
  // weigh in. Kept and disclosed instead, same as the current-multiple
  // divergence check above.
  // Width, not either edge in isolation: `low >= base*0.97 || high <= base*1.03`
  // (the previous formula) fires whenever EITHER edge sits close to base, even
  // with a real, wide gap on the OTHER side — which is exactly the shape a
  // genuine re-rating produces (a stock flat for most of the window, then a
  // real jump in the last year or two: the untouched years cluster the low
  // percentile near the median while the high percentile correctly captures
  // the real outlier). That's informative, not degenerate. A band is only
  // genuinely collapsed when its TOTAL width is near zero.
  const degenerate = !(multiples.base > 0)
    || (multiples.high - multiples.low) < multiples.base * 0.06
  const wideRatio = multiples.low > 0 && (multiples.high / multiples.low) > 2.5
  // `degraded` isn't built until later in this function — flagged here,
  // pushed there, same as divergesFromCurrent above.
  const wideMultipleRange = wideRatio && !degenerate
    ? { low: multiples.low, high: multiples.high } : null
  if (degenerate) {
    // The rejected band's real numbers, disclosed rather than silently
    // dropped — "too erratic to use" told the user nothing about what was
    // actually seen before this fell back to a weaker basis. Sample
    // provenance depends on which source actually produced it — `own`
    // (forwardPeBand, daily-ratio samples) and `fitted`/`historical-median`
    // (targetMultiple, yearly observations) aren't the same kind of count,
    // so naming the wrong one here would just be a different inaccuracy.
    const rejectedSampleNote =
      multipleBasis === 'observed' && own?.samples
        ? `, ${own.samples} samples over ${own.spanYears}y`
        : (multipleBasis === 'fitted' || multipleBasis === 'historical-median') && fitted?.observations
        ? `, ${fitted.observations} years observed`
        : ''
    const rejected = `(rejected: ${round(multiples.low, 1)}×–${round(multiples.high, 1)}× from ${multipleBasis}${rejectedSampleNote})`
    thinMultiple = false   // the rejected band's thinness no longer applies to whatever replaces it
    if (currentPe > 0) {
      const c = currentPe
      const dd = priceDispersion(priceHistory)
      if (dd == null) {
        return blank(
          'Its multiple history is unusable and there is no price history to measure a range from. ' +
          'The fundamentals-based estimate covers this case.',
          { price })
      }
      const sp = dd.half
      thinMultiple = dd.thin
      multiples = { low: round(c * (1 - sp), 1), base: round(c, 1), high: round(c * (1 + sp), 1) }
      multipleBasis = 'current'
      multipleLabel = `today's P/E ±${Math.round(sp * 100)}% — its own history was too thin or too erratic to use ${rejected}`
    } else if (peerBand?.median > 0) {
      multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
      multipleBasis = 'peer'
      multipleLabel = `peer multiples — its own history was unusable ${rejected}`
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
  // marginBasis (the plain 3-yr average net-margin ladder) isn't even
  // consulted when the waterfall ran — its own rung says nothing about
  // whether THAT succeeded, so gating on it here would flag e.g. "no margin
  // history" while the waterfall (a different set of inputs: EBITDA margin,
  // D&A, interest, tax) produced a perfectly good number.
  if (!waterfall && (marginBasis.rung === 'fallback' || marginBasis.rung === 'none'))
    degraded.push(`Margin from ${marginBasis.label}`)
  // This ladder's own rungs are fitted/conditional-own/historical-median/
  // peer/current/revision — 'observed' belongs to a DIFFERENT ladder
  // (buildLenderEstimate's), so comparing against it here always failed to
  // match, meaning even 'fitted' (this ladder's BEST rung — the whole reason
  // targetMultiple.js's regression exists over a plain median) was flagged
  // as degraded on every estimate. 'fitted'/'conditional-own'/
  // 'historical-median' are all real, disclosed, own-history-derived
  // answers (targetMultiple.js's own tier is DERIVED for all three); only
  // 'peer'/'current' are genuine fallbacks worth surfacing here.
  if (multipleBasis === 'peer' || multipleBasis === 'current')
    degraded.push(`Multiple from ${multipleLabel}`)
  if (thinMultiple) degraded.push('Multiple from a thinner-than-usual sample of trading days')
  if (divergesFromCurrent)
    degraded.push(`Selected multiple (${round(multiples.base, 1)}×) differs substantially from today's (${round(currentPe, 1)}×) — ` +
      `could be a real re-rating rather than a bad sample; check the rerating flag before relying on this`)
  if (wideMultipleRange)
    degraded.push(`Historical multiple range is unusually wide (${round(wideMultipleRange.low, 1)}×–${round(wideMultipleRange.high, 1)}×) — ` +
      `could reflect a genuine re-rating rather than noise; check the rerating flag before relying on the low end`)
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

    // When the waterfall ran, projProfit/projRevenue was NEVER
    // marginBasis.margin — it's EBITDA margin minus D&A minus interest plus
    // other income, taxed. marginBasis is a completely separate, unrelated
    // "3-yr average net margin" reading in that case, and displaying it next
    // to the waterfall's own profit figure claimed a margin that wasn't the
    // one actually used — the same inconsistency basisSummary two lines
    // below already correctly avoids by branching on `waterfall` itself.
    marginPct: waterfall
      ? (projRevenue > 0 ? round((projProfit / projRevenue) * 100, 1) : null)
      : (marginBasis.margin != null ? round(marginBasis.margin * 100, 1) : null),
    marginSource: waterfall ? 'waterfall' : marginBasis.source,
    marginLabel: waterfall
      ? `implied by the EBITDA margin (${round(waterfall.drivers.ebitdaMarginPct, 1)}%, ${waterfall.drivers.ebitdaMarginSource}) → EBIT → PBT → net profit waterfall, not a flat margin assumption`
      : marginBasis.label,
    marginTrendPct: waterfall ? null : (marginBasis.trendPct ?? null),

    dilutionPct: round(dilution.rate * 100, 1),
    dilutionLabel: dilution.label,

    multiples, multipleBasis, multipleLabel,
    multipleSteps: fittedSteps,        // the working behind the adjustment
    // Own-history and peer-derived multiples shown SEPARATELY, alongside the
    // final blended figure — otherwise a blend's effect is invisible: only
    // the post-blend number was ever exposed, so there was no way to see
    // whether peers pushed the multiple up 5% or 150%, or why. Null when
    // this rung didn't produce an own-only figure to compare against (the
    // regression-fit and pure-peer-only rungs don't set
    // ownMultipleUnblended), or when no peer band exists at all — nothing to
    // contrast in either case.
    ownPeerBlend: (ownMultipleUnblended && peerBand?.median > 0) ? {
      own: ownMultipleUnblended,
      peer: { low: peerBand.low, median: peerBand.median, high: peerBand.high, count: peerBand.count,
              screeningMode: peerBand.screeningMode ?? null, warning: peerBand.warning ?? null },
      weight: peerWeight,
      // Positive = peers currently command a richer multiple than this
      // stock's own history; negative = peers are cheaper. Signed
      // deliberately so "peer premium: -30%" reads as obviously different
      // from "+30%", not just a magnitude.
      premiumPct: round(((peerBand.median - ownMultipleUnblended.base) / ownMultipleUnblended.base) * 100, 0),
    } : null,
    // The unconditioned historical band, exposed as evidence/context — NEVER
    // fed into target.low/high directly any more. See the conditionalOwn
    // tier above for why: a historical high traded off a near-zero earnings
    // base or a crisis-year collapse describes a regime the forecast year
    // may not be in at all.
    historicalContext,
    target, upside,

    financeability: financeabilityNote(ratioResult, g, { incomeHistory: resolvedOpts.incomeHistory, basis: normBasis }),
    degraded,                     // [] when everything is on its best basis
    // Full driver breakdown when the waterfall actually ran — auditable,
    // not a black box: which EBITDA margin/D&A/interest/tax rate produced
    // this EPS, not just the final number.
    waterfallDrivers: waterfall?.drivers ?? null,
    basisSummary: waterfall
      ? `Growth: ${growthBasis.label} · EBITDA margin: ${round(waterfall.drivers.ebitdaMarginPct, 1)}% (${waterfall.drivers.ebitdaMarginSource}) · Multiple: ${multipleLabel}`
      : `Growth: ${growthBasis.label} · Margin: ${marginBasis.label} · Multiple: ${multipleLabel}`,
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
 * @param context   { price, fairValue: number, analystTarget: {low,high} }
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
  // `fairValue` is the real headline number (primaryModel's own value, not a
  // midpoint of how far apart the extrinsic models are — that's a different
  // question, already surfaced separately as the Fair Value range itself).
  if (fairValue > 0) {
    const r = mid / fairValue
    // Tighter than the price check on purpose. Fair value and the estimate run
    // different methods over the SAME statements, so they should broadly agree;
    // price can legitimately sit far from both. SBIN sat at 0.60 of fair value
    // — inside a 0.4 threshold and still plainly wrong — which is what set this.
    if (r > 2 || r < 0.65) issues.push({ severity: 'medium', kind: 'fair-value',
      note: `Fair value says ${Math.round(fairValue)}, this estimate says ${Math.round(mid)} — ` +
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

function blank(note, extra = {}) {
  return {
    ok: false, note, target: null, upside: null, multiples: null,
    growth: null, growthPct: null, growthSource: 'none',
    degraded: [], basisSummary: null,
    priceAtEstimate: extra.price != null ? round(extra.price) : null,
  }
}
