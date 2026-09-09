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
import { justifiedMultiples, preferredForm, averagePayoutPct } from './justifiedMultiple.js'
import { percentileSpread, filterRelativeOutliers } from './spread.js'

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
  // A loss year isn't excluded because it's an outlier to be filtered out —
  // P/E is mathematically undefined for negative earnings, dividing by a
  // negative number doesn't produce "a low multiple," it's a different,
  // meaningless quantity for this purpose. So it's not usable as a
  // year-to-price-against, but that's not the same as invisible: counted
  // here and disclosed by the caller (own.excludedLossYears), rather than
  // silently vanishing with nothing on screen saying a year was skipped.
  let excludedLossYears = 0
  for (const row of incomeHistory || []) {
    const y = yearOf(row), e = val(row?.eps)
    if (y == null) continue
    if (e != null && e <= 0) { excludedLossYears++; continue }
    if (e > 0) epsByYear.set(y, e)
  }

  const ratios = []
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
    let any = false
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      const pe = c.close / nextEps
      if (pe > 0) { ratios.push(pe); any = true }
    }
    if (any) pairedYears++
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
  return { low: round(ps.low, 1), median: round(ps.median, 1), high: round(ps.high, 1),
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
           excludedLossYears }
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

  const band = pbBand(priceHistory, balanceHistory,
    opts.reportedIncomeHistory?.length ? opts.reportedIncomeHistory : incomeHistory)
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
    degraded: [
      ...(growthInfo.unusual
        ? [`Growth rate (${round(growth * 100, 0)}%) is well outside a typical range — likely a recovery from a collapsed base or a one-off`]
        : []),
      ...(thinDispersion ? ['Spread width from a thinner-than-usual sample of trading days'] : []),
    ],
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
    ],
    basisSummary: `Revenue ${round(forwardRevenue)} × ${round(multiple, 2)}× sales, less net debt`,
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
    growthLabel: `${round(jm.growth.roe, 1)}% ROE × ${round(jm.growth.retention * 100, 0)}% retained`,
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
    priceHistory = [], incomeHistory = [], balanceHistory = [],
    peerBand = null, peerWeight = 0, years = 1,
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
    peerWeight,
  })

  // Reported series for the band; normalised for the projection. See the note
  // on forwardPeBand.
  const bandHistory = opts.reportedIncomeHistory?.length ? opts.reportedIncomeHistory : incomeHistory
  const ownRaw = forwardPeBand(priceHistory, bandHistory)
  const bandReason = ownRaw?.insufficient ? ownRaw.reason : null
  let own = ownRaw?.insufficient ? null : ownRaw

  // A measured band sitting far from today's multiple (LIC: band 60-75x
  // against a stock trading near 14x) used to be discarded outright — but
  // "the band disagrees with today's price" is exactly what a genuine
  // re-rating looks like, not only what a bad sample (a recent listing, a
  // loss year, a demerger) looks like, and this had no way to tell the two
  // apart before throwing the real measured data away. rerating.js exists
  // specifically to make that distinction (how long the deviation has
  // persisted, whether the sector moved too) — silently discarding the band
  // here never gave it the chance. Kept and disclosed instead: the real
  // band, with the gap named as a caveat rather than hidden behind a weaker
  // fallback.
  let ownDivergesFromCurrent = false
  if (own && currentPe > 0) {
    const ratio = own.median / currentPe
    ownDivergesFromCurrent = ratio > 2.5 || ratio < 0.4
  }

  let multiples, multipleBasis, multipleLabel, thinMultiple = false, divergesFromCurrent = false, ownPeerBlend = null
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
  } else if (own) {
    // Comparable-company cross-checking a firm's own historical multiple is
    // standard analyst practice (see targetMultiple.js's own citations —
    // Bradshaw 2002, Yin/Peasnell & Hunt 2018) and this app already applies
    // it via peerWeight whenever targetMultiple()'s regression or plain
    // median wins. It had no way to apply to THIS band at all — forwardPeBand
    // was never given peerWeight/peerBand as inputs — which meant the same
    // user-set slider silently did nothing whenever this (the most common)
    // branch was the one chosen, with no indication that was happening.
    // Mirrors targetMultiple.js's own blend formula exactly: center blends
    // toward the peer median, and the RANGE'S WIDTH (not the edges
    // independently) blends toward the peer band's own width, so a
    // confident, narrow peer band can genuinely tighten an unusually wide
    // own-history band instead of just recentring it.
    let ownLow = own.low, ownMedian = own.median, ownHigh = own.high
    if (peerWeight > 0 && peerBand?.median > 0) {
      ownMedian = (1 - peerWeight) * own.median + peerWeight * peerBand.median
      const ownMargin = (own.high - own.low) / 2
      if (peerBand.low > 0 && peerBand.high > 0) {
        const peerMargin = (peerBand.high - peerBand.low) / 2
        const blendedMargin = (1 - peerWeight) * ownMargin + peerWeight * peerMargin
        ownLow = ownMedian - blendedMargin
        ownHigh = ownMedian + blendedMargin
      } else {
        ownLow = ownMedian - ownMargin
        ownHigh = ownMedian + ownMargin
      }
      if (!(ownLow > 0)) ownLow = Math.min(own.low, ownMedian * 0.5)   // structural floor, not a plausibility cap
      ownPeerBlend = { pct: Math.round(peerWeight * 100), peerMedian: round(peerBand.median, 1) }
    }
    multiples = { low: round(ownLow, 1), base: round(ownMedian, 1), high: round(ownHigh, 1) }
    multipleBasis = 'observed'
    thinMultiple = !!own.thin
    divergesFromCurrent = ownDivergesFromCurrent
    // Name the span, not just the sample count. A band from three years and one
    // from nine both looked identical as "its own forward P/E range"; the first
    // describes a recent regime and the second a genuine range.
    // The span is stated either way; the prompt appears while a longer history
    // is still available to fetch, without implying the shorter one is invalid.
    multipleLabel = `its own forward P/E over ${own.spanYears} year${own.spanYears === 1 ? '' : 's'}` +
      (own.spanYears < 5 ? ' — paste the Screener tables for a longer range' : '') +
      // Disclosed, not hidden: P/E is undefined for a loss year, so it
      // can't be used as a pairing year — but the exclusion itself, and
      // how many years it applied to, is visible rather than silent.
      (own.excludedLossYears > 0
        ? ` (excludes ${own.excludedLossYears} loss year${own.excludedLossYears === 1 ? '' : 's'} — P/E undefined for negative earnings)`
        : '') +
      (ownPeerBlend ? ` — blended ${ownPeerBlend.pct}% toward peers' ${ownPeerBlend.peerMedian}× median` : '')
    // targetMultiple() ran (it's computed unconditionally above, before this
    // branch is even chosen) and may have tried a regression adjustment for
    // returns/growth against this stock's own history — but its result only
    // gets used when it actually wins one of the branches below/above this
    // one. When THIS band wins instead, that reasoning — including exactly
    // why a fit was or wasn't trusted (R² too low, not enough years, no
    // forward figure) — used to be silently thrown away with no way to see
    // it. Surfaced here instead, through the same multipleSteps UI already
    // used for an adopted fit, with a header line making clear this is the
    // REJECTED path, not what's shown above.
    if (fitted?.steps?.length) {
      fittedSteps = [
        'A regression-based adjustment (this stock\'s own ROE/growth vs. its multiple) was tried but not used — the plain historical band above is shown instead:',
        ...fitted.steps,
      ]
    }
  } else if (fitted?.multiple > 0 && fitted.source === 'historical-median') {
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'historical-median'
    thinMultiple = !!fitted.thin
    multipleLabel = `its own median multiple over ${fitted.observations} years`
    fittedSteps = fitted.steps
  } else if (fitted?.multiple > 0 && fitted.source === 'peers') {
    // targetMultiple() falls back to peers itself when this stock has fewer
    // than 3 years of matched price/earnings history (too recently listed to
    // measure a real band of its own) — that result was being displayed with
    // the SAME "its own median multiple" label as the branch above, i.e. as
    // if it had been measured from this stock's own trading when it was
    // actually borrowed from other companies. Routed to the same 'peer'
    // basis (and its existing, honest caveat) used elsewhere in this chain.
    multiples = { low: fitted.low, base: fitted.multiple, high: fitted.high }
    multipleBasis = 'peer'
    multipleLabel = `peer multiples — only ${fitted.observations} year${fitted.observations === 1 ? '' : 's'} of this stock's own trading history, too little to measure its own band`
    fittedSteps = fitted.steps
  } else if (peerBand?.median > 0) {
    multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
    multipleBasis = 'peer'
    multipleLabel = 'peer multiples (no usable history for this stock)'
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
  if (marginBasis.rung === 'fallback' || marginBasis.rung === 'none')
    degraded.push(`Margin from ${marginBasis.label}`)
  if (multipleBasis !== 'observed' && multipleBasis !== 'revision')
    degraded.push(`Multiple from ${multipleLabel}`)
  if (thinMultiple) degraded.push('Multiple from a thinner-than-usual sample of trading days')
  if (divergesFromCurrent)
    degraded.push(`Historical multiple (${round(own.median, 1)}×) differs substantially from today's (${round(currentPe, 1)}×) — ` +
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

    marginPct: marginBasis.margin != null ? round(marginBasis.margin * 100, 1) : null,
    marginSource: marginBasis.source,
    marginLabel: marginBasis.label,
    marginTrendPct: marginBasis.trendPct ?? null,

    dilutionPct: round(dilution.rate * 100, 1),
    dilutionLabel: dilution.label,

    multiples, multipleBasis, multipleLabel,
    multipleSteps: fittedSteps,        // the working behind the adjustment
    ownPeerBlend,                      // { pct, peerMedian } when the observed band was blended toward peers, else null
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
