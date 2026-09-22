/**
 * src/engine/justifiedMultiple.js — the multiple a company's fundamentals
 * support, derived rather than measured.
 *
 * The other method (targetMultiple.js) reads what the market HAS paid and
 * adjusts it. That needs years of stable price history, and quietly falls apart
 * without them — a stock with two usable years produced a 59-171x band and an
 * estimate three times its own price.
 *
 * This one needs no price history at all. The standard CFA relationships state
 * what a multiple should be given growth, returns and the return an investor
 * requires:
 *
 *   Justified P/E = payout / (r - g)
 *   Justified P/B = (ROE - g) / (r - g)
 *   EV/EBITDA and EV/Sales follow the same present-value logic
 *
 * The two methods answer different questions — "what does the market pay" versus
 * "what do the fundamentals support" — so they are shown side by side rather
 * than reconciled. A persistent gap between them is the classic cheap/expensive
 * reading arrived at independently, not an error in either.
 */

import { capmCostOfEquity, TERMINAL_GROWTH_BY_MARKET } from './requiredReturn.js'
import { TIER } from './methodologyTier.js'
import { activeValue } from './dataQuality.js'
import { latestRealRow, averagePayoutPct, fieldHistory, resolveAnnualRoe, extrapolatedCurrentYearNetProfit } from './formulas.js'

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)
const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// Terminal growth cannot exceed the economy forever — a company growing faster
// than nominal GDP in perpetuity eventually becomes the economy. Shared with
// DCF's own terminal growth (src/engine/requiredReturn.js), split by market
// there for the same reason it's resolved per-market here (see
// justifiedMultiples() below) rather than as one module-level constant.

// Explicit high-growth window before the fade. Five to ten years is the usual
// range in practice; the shorter end is used because a longer window compounds
// an assumed rate further.
const STAGE_1_YEARS = 5

/**
 * Required return on equity — CAPM. Thin wrapper over the shared
 * capmCostOfEquity() (src/engine/requiredReturn.js) — same signature and
 * "decline to null when no rate is available" behavior as before, so every
 * existing call site (estimate.js, useEstimate.js) needs zero changes.
 */
export function requiredReturn({ riskFreeRate, beta, equityRiskPremium = null, market = 'IN', betaMeta = null } = {}) {
  return capmCostOfEquity({ riskFreeRate, beta, erp: equityRiskPremium, market, betaMeta })
}

/** Sustainable growth: what the business can fund from what it keeps. */
export function sustainableGrowth({ roe, payoutPct } = {}) {
  if (!(roe > 0)) return null
  // A company with no reported payout is treated as retaining everything — a
  // non-dividend payer reinvests all earnings, so g = ROE. This is the standard
  // treatment; refusing to compute would drop P/B and every payout-free form too.
  if (payoutPct == null) {
    return { g: roe / 100, retention: 1, roe, payoutPct: 0, payoutAssumed: true }
  }
  if (payoutPct < 0 || payoutPct > 100) return null
  const retention = 1 - payoutPct / 100
  return { g: (roe / 100) * retention, retention, roe, payoutPct }
}

/**
 * Linear fade from `start` to `end` across `years` periods, reaching `end`
 * exactly at the last period — the same H-model-style linear fade
 * convention valuation.js's own DCF terminal-value already uses (Fuller &
 * Hsia, 1984: growth declines by a constant AMOUNT each year, arriving at
 * the terminal rate exactly rather than asymptotically). Applied here to
 * both the growth rate (g1 -> terminalG) and, for P/B, ROE itself
 * (roeStart -> r) — replacing what used to be a FLAT rate for all
 * `years` years followed by a sudden jump to the terminal rate. That
 * discontinuity (e.g. 46%, 46%, 46%, 46%, 46%, then instantly 5%) wasn't a
 * defensible forecast, just the easiest thing to code.
 */
function fadeSchedule(start, end, years) {
  if (years <= 1) return [end]
  return Array.from({ length: years }, (_, i) => start - (start - end) * i / (years - 1))
}

/**
 * Present value of a two-stage stream, expressed as a multiple.
 *
 * Used when g >= r, where the single-stage formula divides by zero or turns
 * negative. That isn't a flaw to work around — it's the model correctly refusing
 * an impossible assumption, since no company outgrows its discount rate forever.
 */
function twoStageMultiple({ payout, g1, r, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null

  // Stage 1: dividends at the CURRENT payout, growing at a rate fading
  // linearly from g1 down to terminalG (reached exactly by year `years`).
  const growthPath = fadeSchedule(g1, terminalG, years)
  let pv = 0
  let dividend = payout
  for (let t = 1; t <= years; t++) {
    dividend *= (1 + growthPath[t - 1])
    pv += dividend / Math.pow(1 + r, t)
  }

  // Terminal: the payout RISES when growth fades — a company growing 25%
  // retains almost everything, but one growing 6% only needs to retain g/ROE
  // to fund that growth and pays out the rest. ROE itself has also faded to
  // `r` by year `years` (the standard "excess returns erode to the cost of
  // capital" assumption — a company earning exactly its cost of equity in
  // the terminal state), so the terminal payout is solved against `r`
  // directly rather than the company's (possibly much higher) starting ROE.
  const terminalPayout = Math.max(0, Math.min(1, 1 - terminalG / r))
  const earningsAtT = dividend / payout          // per unit of current earnings
  const terminal = (earningsAtT * (1 + terminalG) * terminalPayout) / (r - terminalG)
  pv += terminal / Math.pow(1 + r, years)
  return pv
}

/**
 * The EV/EBITDA and EV/Sales analog of twoStageMultiple() above — same shape,
 * different unit (cash reaching investors per unit of TODAY's EBITDA/revenue,
 * instead of dividends per unit of today's earnings).
 *
 * Before this existed, the EV/EBITDA and EV/Sales forms below skipped the
 * two-stage structure entirely and fell straight to `conversion / (r -
 * terminalG)` — a SINGLE-STAGE Gordon-growth formula applied to TODAY's
 * EBITDA, as if growth dropped to the terminal rate starting immediately.
 * That gave zero credit for the explicit high-growth years the P/E form
 * already models correctly, so any company whose growth exceeds its required
 * return (the two-stage trigger) got a structurally understated EV/EBITDA —
 * exactly backwards for the companies where getting the growth years right
 * matters most.
 *
 * `conversion` is held constant across both stages, unlike payout above
 * (which correctly rises as growth fades) — there's no EBITDA-based ROIC
 * input here to derive a terminal conversion rate the same principled way,
 * and `conversion` is already a coarse, bounded proxy rather than a precise
 * reinvestment-need calculation. Holding it constant is a reasonable
 * simplification; it is not the gap this function exists to close.
 */
function twoStageEvMultiple({ conversion, g1, r, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null

  // Stage 1: cash reaching investors, per unit of TODAY's EBITDA/revenue,
  // growing at a rate fading linearly from g1 to terminalG.
  const growthPath = fadeSchedule(g1, terminalG, years)
  let pv = 0
  let cf = conversion
  for (let t = 1; t <= years; t++) {
    cf *= (1 + growthPath[t - 1])
    pv += cf / Math.pow(1 + r, t)
  }

  // Terminal: EBITDA/revenue has grown along the fade path by the time it
  // fades — the terminal value sits on THAT base, discounted back from
  // year `years`, mirroring earningsAtT above.
  const baseAtT = cf / conversion   // per unit of today's EBITDA/revenue
  const terminal = (baseAtT * (1 + terminalG) * conversion) / (r - terminalG)
  pv += terminal / Math.pow(1 + r, years)
  return pv
}

/**
 * The P/B analog of twoStageMultiple() (P/E) — same shape, but for book value
 * instead of earnings, and needing no dividend data as an input (matching
 * the single-stage P/B form's own "needs no payout" property).
 *
 * Before this existed, the P/B block below did the same flat-terminal
 * substitution the EV/EBITDA and EV/Sales forms used to (gUsed = twoStage ?
 * TERMINAL_GROWTH_CAP : g fed straight into the single-stage formula) — no
 * explicit stage-1 credit for the years of real high growth before the fade,
 * understating the justified multiple for exactly the high-growth,
 * non-dividend-paying companies where this form matters most.
 *
 * P/E needs an explicit payoutPct input; P/B derives an EQUIVALENT implied
 * payout from g and ROE themselves (payout = 1 - g/ROE, the same
 * sustainable-growth relationship — g = ROE x retention — that produced g in
 * the first place, just solved for the other variable, EACH YEAR along its
 * own fade path rather than frozen at the starting rate). That's what lets
 * this stay payout-data-free, like the single-stage P/B form already is.
 *
 * ROE fades too, from `roeStart` to `r` — a company earning an unusually
 * high ROE today (the reason two-stage triggered at all) isn't assumed to
 * keep earning it forever; competitive erosion normalizes it toward the
 * cost of equity over the same window growth fades over. Both P/B's
 * per-year dividend AND its book-compounding rate use the CURRENT year's
 * point on each fade path, not the starting or ending value alone.
 */
function twoStagePbMultiple({ roeStart, g1, r, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null
  const roeStartDec = roeStart / 100
  if (!(roeStartDec > 0)) return null

  const growthPath = fadeSchedule(g1, terminalG, years)
  const roePath = fadeSchedule(roeStartDec, r, years)

  // Stage 1: dividends at the implied payout, per unit of TODAY's book value.
  // Book value at the START of year t earns that year's (faded) ROE; what
  // isn't paid out is retained and grows next year's book base at that
  // year's (faded) growth rate.
  let pv = 0
  let bookAtStart = 1   // per unit of today's book value
  for (let t = 1; t <= years; t++) {
    const gt = growthPath[t - 1]
    const roet = roePath[t - 1]
    const payoutT = Math.max(0, Math.min(1, 1 - gt / roet))
    const dividend = bookAtStart * roet * payoutT
    pv += dividend / Math.pow(1 + r, t)
    bookAtStart *= (1 + gt)
  }

  // Terminal: bookAtStart already IS the book value at the START of the
  // terminal year (year `years`+1) — the loop above updates it AFTER each
  // dividend is taken, so by the time it exits, bookAtStart has already
  // compounded one step past the last explicit stage-1 dividend. Earnings for
  // that terminal year are bookAtStart x ROE directly; no extra (1+terminalG)
  // step is needed here (unlike twoStageMultiple's P/E form, whose `earningsAtT`
  // is deliberately computed as the level AT year `years`, one step short of
  // the terminal year, and does need that step). ROE by now has faded to `r`
  // exactly (roePath's last point), so the terminal payout solves against
  // `r` directly, same as twoStageMultiple's terminal payout above.
  const terminalPayout = Math.max(0, Math.min(1, 1 - terminalG / r))
  const terminal = (bookAtStart * r * terminalPayout) / (r - terminalG)
  pv += terminal / Math.pow(1 + r, years)
  return pv
}

/**
 * The starting ROE for the two-stage fade (`roeStart` in twoStagePbMultiple/
 * twoStageMultiple above), preferring a CURRENT estimate over the 3-year
 * annual median wherever one is actually available:
 *
 *   1. Mid-year quarters for the current, not-yet-annually-reported fiscal
 *      year, extrapolated to a full year via seasonality learned from a
 *      prior complete year (extrapolatedCurrentYearNetProfit, formulas.js
 *      — shared with rerating.js's own trailing-EPS basis, since ROE and
 *      EPS are just different ratios of the same extrapolated net profit)
 *      — the only case quarterly data is worth anything for this purpose.
 *      (A full 4-quarter "TTM" is NOT a separate case: in Indian reporting
 *      Q4 is never independently published, it's back-solved as Annual −
 *      (Q1+Q2+Q3), so summing 4 quarters is mathematically identical to
 *      the annual figure already sitting in the income table — no new
 *      information, not worth a special path.)
 *   2. Otherwise, the SAME 3-year annual median already computed for the
 *      Sustainable Growth Rate trigger (`fallbackRoe` — no second,
 *      independent calculation).
 *
 * Returns { roe, source } — `source` feeds the on-screen rationale so
 * which basis actually produced the number is never hidden.
 */
export function determineROEStart({ data, basis, fallbackRoe, latestBalRow }) {
  const equity = val(activeValue(latestBalRow, 'totalEquity', basis))
  if (equity > 0) {
    const extrap = extrapolatedCurrentYearNetProfit({ quarterlyHistory: fieldHistory(data, 'quarterly'), basis })
    if (extrap) return { roe: (extrap.netProfit / equity) * 100, source: extrap.source }
  }
  return { roe: fallbackRoe, source: '3-year annual median' }
}

/**
 * Every justified multiple the inputs can support. Returns null for a form whose
 * inputs are missing rather than substituting a value — a blank with a stated
 * reason is more useful than a number nobody can trace.
 */
export function justifiedMultiples(ratioResult, opts = {}) {
  // market was previously accepted here but never read — every call (even
  // from valuation.js's US-ticker path) silently defaulted to requiredReturn's
  // own 'IN' default inside capmCostOfEquity. Harmless while ERP_BY_MARKET's
  // IN/US values were identical, but a real bug once terminal growth (below)
  // is split by market instead of shared.
  const { riskFreeRate, equityRiskPremium, beta, betaMeta = null, incomeHistory = [],
          balanceHistory = [], quarterlyHistory = [], market = 'IN' } = opts
  const R = ratioResult?.ratios || {}
  // roe/dividendPayout/ebitda/revenue are table-native — read off the latest
  // real row directly, falling back to ratioResult when the table can't
  // resolve one (e.g. a caller supplying a hand-built ratioResult without a
  // live materialized table, same reasoning as estimate.js's builders).
  const latestIncJm = latestRealRow(incomeHistory)
  const latestBalRow = latestRealRow(balanceHistory)

  // ROE: the one shared answer to "what is this company's ROE" every
  // ROE-based valuation method here uses (resolveAnnualRoe, formulas.js) —
  // preferring the Formulas tab's own Sustainable Growth Rate window
  // (materializeSustainableGrowth, user-adjustable there, same start/end
  // year controls Revenue/Net Profit Growth already have) over a second,
  // independent 3-year median computed fresh. sgMethods is kept here only
  // for payoutPct below, which resolveAnnualRoe doesn't carry.
  const sgMethods = activeValue(latestIncJm, 'sustainableGrowth', opts.basis)?.methods
  const roeResolved = resolveAnnualRoe({ incomeHistory, balanceHistory, basis: opts.basis, ratioResult })
  const roe = roeResolved.value
  const payoutPct = sgMethods?.payoutPct ?? activeValue(latestIncJm, 'dividendPayout', opts.basis)?.value ?? R.dividendPayout?.value
    ?? averagePayoutPct(incomeHistory, {
    cashflowHistory: opts.cashflowHistory || [],
    dividendYield: R.dividendYield?.value ?? null,
    pe: R.pe?.value ?? null,
    basis: opts.basis,
  })
  const rr = requiredReturn({ riskFreeRate, beta, equityRiskPremium, market, betaMeta })
  const sg = sustainableGrowth({ roe, payoutPct })
  const terminalG = TERMINAL_GROWTH_BY_MARKET[market] ?? TERMINAL_GROWTH_BY_MARKET.IN

  const missing = []
  if (!rr) missing.push('risk-free rate')
  if (roe == null) missing.push('ROE')
  if (payoutPct == null) missing.push('dividend payout history')

  if (!rr || !sg) return { available: false, missing, forms: {} }

  const { r } = rr
  const { g, retention } = sg
  const forms = {}
  const twoStage = g >= r

  // The two-stage fade's OWN starting point — a current estimate (mid-year
  // quarters, seasonality-extrapolated) when one exists, else the same
  // 3-year median that decided the trigger above. Only computed when
  // actually needed: single-stage uses the plain g/roe directly, and this
  // does real work (reading quarterly data) that would be wasted otherwise.
  // g1/roeStartPct feed EVERY two-stage form below identically — one shared
  // starting point, not a per-form recomputation.
  let g1 = g, roeStartPct = roe, roeStartSource = null
  if (twoStage) {
    const started = determineROEStart({ data: { reportedIncomeHistory: incomeHistory, quarterlyHistory }, basis: opts.basis, fallbackRoe: roe, latestBalRow })
    roeStartPct = started.roe
    roeStartSource = started.source
    g1 = (roeStartPct / 100) * retention
  }

  // P/E — a company paying nothing has a justified P/E of zero under the
  // single-stage formula, which is a limitation of the FORM rather than a
  // valuation. Those are better served by P/B, so this returns nothing.
  if (payoutPct > 0) {
    const payout = payoutPct / 100
    const pe = twoStage ? twoStageMultiple({ payout, g1, r, terminalG })
                        : (payout * (1 + g)) / (r - g)
    if (pe > 0 && isFinite(pe)) {
      forms.pe = {
        multiple: round(pe, 1), basis: 'pe', tier: TIER.DERIVED,
        label: twoStage ? 'Justified P/E (two-stage)' : 'Justified P/E',
        steps: twoStage
          ? [`Sustainable growth capacity (ROE × retention) is ${round(g * 100, 1)}%, which exceeds the ${round(r * 100, 1)}% required return`,
             `Starting growth for the model is ${round(g1 * 100, 1)}%, from ROE ${round(roeStartPct, 1)}% (${roeStartSource})`,
             `Modelled explicitly for ${STAGE_1_YEARS} years, fading linearly to ${round(terminalG * 100, 1)}% growth and ${round(r * 100, 1)}% ROE`,
             `Payout rises from ${round(payoutPct, 0)}% toward ${round((1 - terminalG / r) * 100, 0)}% as growth and ROE both fade`,
             `— a company that stops reinvesting, and whose returns normalize, pays out what it no longer needs`]
          : [`Payout ${round(payoutPct, 0)}% / (${round(r * 100, 1)}% required - ${round(g * 100, 1)}% growth)`],
      }
    }
  } else {
    missing.push('a dividend — justified P/E needs a payout, so P/B is the right form here')
  }

  // P/B — needs no payout, which is why it serves non-payers and lenders alike.
  // A company earning exactly its cost of equity is worth its book; the spread
  // between ROE and r is what justifies a premium.
  if (roe != null) {
    const roeDec = roe / 100
    const pb = twoStage
      ? twoStagePbMultiple({ roeStart: roeStartPct, g1, r, terminalG })
      : (r - g > 0 ? (roeDec - g) / (r - g) : null)
    if (pb > 0 && isFinite(pb)) {
      forms.pb = {
        multiple: round(pb, 2), basis: 'pb', tier: TIER.DERIVED,
        label: twoStage ? 'Justified P/B (two-stage)' : 'Justified P/B',
        steps: twoStage
          ? [`Sustainable growth capacity (ROE × retention) is ${round(g * 100, 1)}%, which exceeds the ${round(r * 100, 1)}% required return`,
             `Starting point for the model is ROE ${round(roeStartPct, 1)}% (${roeStartSource}), implying ${round(g1 * 100, 1)}% growth`,
             `Modelled explicitly for ${STAGE_1_YEARS} years, with BOTH growth and ROE fading linearly — growth to ${round(terminalG * 100, 1)}%, ROE to this company's own ${round(r * 100, 1)}% cost of equity`,
             `Implied payout rises each year as both fade, same relationship as the Justified P/E basis`]
          : [`(ROE ${round(roe, 1)}% - growth ${round(g * 100, 1)}%) / (required ${round(r * 100, 1)}% - growth ${round(g * 100, 1)}%)`,
             roeDec > r ? 'Earning above its cost of equity, so worth more than book.'
                        : 'Earning below its cost of equity, so worth less than book.'],
      }
    }
  }

  // EV/EBITDA — for businesses whose depreciation makes net profit
  // uninformative. Same present-value logic on the cash the assets throw off.
  const ebitda = activeValue(latestIncJm, 'ebitda', opts.basis)?.value ?? ratioResult?.ebitda ?? R.ebitda?.value
  const revenue = activeValue(latestIncJm, 'revenue', opts.basis)?.value ?? ratioResult?.revenue
  if (ebitda > 0 && revenue > 0) {
    // Share of EBITDA reaching investors after tax and reinvestment. Prefer
    // this company's own MEASURED FCF/EBITDA conversion over a guess — but a
    // SINGLE year's conversion is exactly as fragile here as a single year's
    // ROE was for the growth input (see the ROE ladder above): a capex
    // spike, a working-capital release, or any other one-year distortion
    // would otherwise set this entire justified multiple. Normalized to the
    // MEDIAN across valid historical years instead — only falling to the
    // latest single year when there isn't enough history for a median to
    // mean anything, and only falling further to the estimated `1 -
    // retention x 0.5` guess when FCF genuinely isn't available at all. No
    // bound on the measured case: a real, differentiated business
    // (near-zero-capex software vs. heavy-capex manufacturing) can
    // legitimately sit anywhere in a wide range, and clamping a real
    // measured ratio to fit an assumed band replaces real data with a
    // guess. Deliberately historical only — never the forecast year's own
    // FCF/EBITDA (e.g. from buildWaterfallForecast), which would make this
    // "independently justified" multiple partly circular with the forecast
    // it's meant to be checked against.
    const conversionPoints = []
    for (const cfRow of (opts.cashflowHistory || [])) {
      const y = yearOf(cfRow)
      if (y == null) continue
      const fcfY = val(activeValue(cfRow, 'freeCashFlow', opts.basis))
      if (!(fcfY > 0)) continue   // a negative/zero conversion isn't a real rate to feed conversion/(r-g) with
      const incRowY = (incomeHistory || []).find(row => yearOf(row) === y)
      const ebitdaY = val(activeValue(incRowY, 'ebitda', opts.basis))
      if (!(ebitdaY > 0)) continue
      conversionPoints.push({ year: y, ratio: fcfY / ebitdaY })
    }
    conversionPoints.sort((a, b) => a.year - b.year)

    const MIN_YEARS_FOR_CONVERSION_MEDIAN = 3
    let measuredConversion = null, conversionSource = null
    if (conversionPoints.length >= MIN_YEARS_FOR_CONVERSION_MEDIAN) {
      const sortedRatios = [...conversionPoints.map(p => p.ratio)].sort((a, b) => a - b)
      measuredConversion = sortedRatios[Math.floor(sortedRatios.length / 2)]
      conversionSource = `${conversionPoints.length}yr-median`
    } else if (conversionPoints.length >= 1) {
      measuredConversion = conversionPoints[conversionPoints.length - 1].ratio
      conversionSource = 'latest-year'
    }
    const conversion = measuredConversion != null
      ? measuredConversion
      : Math.max(0, Math.min(1, retention > 0 ? 1 - retention * 0.5 : 0.5))
    const evEbitda = twoStage
      ? twoStageEvMultiple({ conversion, g1, r, terminalG })
      : (r - g > 0 ? conversion / (r - g) : null)
    if (evEbitda > 0 && isFinite(evEbitda)) {
      const conversionLabel =
        conversionSource?.endsWith('yr-median') ? `median of ${conversionPoints.length} years' own measured FCF/EBITDA` :
        conversionSource === 'latest-year' ? 'this company\'s own latest-year FCF/EBITDA — too little history for a median' :
        'estimated — FCF not available'
      forms.evEbitda = {
        multiple: round(evEbitda, 1), basis: 'evEbitda',
        // DERIVED when a real measured FCF/EBITDA conversion anchors it
        // (median or, failing that, latest-year); ASSUMED when the
        // estimated-fallback conversion is used — the comment above already
        // calls that "an invented halving with no derivation behind it."
        tier: measuredConversion != null ? TIER.DERIVED : TIER.ASSUMED,
        label: twoStage ? 'Justified EV/EBITDA (two-stage)' : 'Justified EV/EBITDA',
        steps: twoStage
          ? [`Sustainable growth capacity (ROE × retention) is ${round(g * 100, 1)}%, which exceeds the ${round(r * 100, 1)}% required return`,
             `Starting growth for the model is ${round(g1 * 100, 1)}%, from ROE ${round(roeStartPct, 1)}% (${roeStartSource})`,
             `Modelled explicitly for ${STAGE_1_YEARS} years, fading linearly to ${round(terminalG * 100, 1)}%`,
             `${round(conversion * 100, 0)}% of EBITDA reaching investors (${conversionLabel}), applied to EBITDA at each stage (held constant — no ROIC-based terminal conversion to fade it toward)`]
          : [`${round(conversion * 100, 0)}% of EBITDA reaching investors (${conversionLabel}) / (${round(r * 100, 1)}% required - ${round(g * 100, 1)}% growth)`,
             `EBITDA margin ${round((ebitda / revenue) * 100, 1)}%`],
      }
    }
  }

  // EV/Sales — last resort, for companies with no positive earnings. Weak by
  // construction: it prices revenue without knowing whether it converts to cash.
  const netMargin = R.netMargin?.value
  if (netMargin > 0 && revenue > 0) {
    const conversion = netMargin / 100
    const evSales = twoStage
      ? twoStageEvMultiple({ conversion, g1, r, terminalG })
      : (r - g > 0 ? conversion / (r - g) : null)
    if (evSales > 0 && isFinite(evSales)) {
      forms.evSales = {
        multiple: round(evSales, 2), basis: 'evSales',
        // ASSUMED — net margin standing in for cash conversion has no
        // formula backing (this file's own "weak by construction" framing
        // above), unlike EV/EBITDA's measured-FCF path.
        tier: TIER.ASSUMED,
        label: twoStage ? 'Justified EV/Sales (two-stage)' : 'Justified EV/Sales',
        steps: twoStage
          ? [`Sustainable growth capacity (ROE × retention) is ${round(g * 100, 1)}%, which exceeds the ${round(r * 100, 1)}% required return`,
             `Starting growth for the model is ${round(g1 * 100, 1)}%, from ROE ${round(roeStartPct, 1)}% (${roeStartSource})`,
             `Modelled explicitly for ${STAGE_1_YEARS} years, fading linearly to ${round(terminalG * 100, 1)}%`,
             `Net margin ${round(netMargin, 1)}%, applied to revenue at each stage`]
          : [`Net margin ${round(netMargin, 1)}% / (${round(r * 100, 1)}% - ${round(g * 100, 1)}%)`],
      }
    }
  }

  return {
    available: Object.keys(forms).length > 0,
    forms, missing,
    requiredReturn: rr,
    growth: { g, gPct: round(g * 100, 1), retention, roe,
      roeSource: roeResolved.source,
      payoutPct,
      // Only meaningful once two-stage triggers — the actual starting point
      // fed to the fade, vs `g`/`roe` above (the trigger's own inputs,
      // unchanged, still what decides single- vs two-stage).
      twoStageStart: twoStage ? { g1, g1Pct: round(g1 * 100, 1), roeStartPct: round(roeStartPct, 1), roeStartSource } : null,
    },
    twoStage,
    stageOneYears: twoStage ? STAGE_1_YEARS : null,
    terminalGrowthPct: twoStage ? round(terminalG * 100, 1) : null,
  }
}

/**
 * Which form to lead with, by sector convention. Several forms can be
 * simultaneously valid, so this picks by rule rather than by a scoring function
 * — a rule is inspectable and switchable, a score is neither. The user can
 * change it to any other form the inputs support.
 */
export function preferredForm(sectorType, forms = {}, ratioResult = null) {
  const has = k => forms[k]?.multiple > 0
  if (!(ratioResult?.eps > 0)) {
    if (has('evSales')) return 'evSales'
    if (has('pb')) return 'pb'
  }
  switch (sectorType) {
    case 'bank': case 'nbfc': case 'insurance': case 'financial':
      return has('pb') ? 'pb' : has('pe') ? 'pe' : firstOf(forms)
    case 'cyclical': case 'realty':
      // Book is stable across a cycle in a way earnings are not.
      return has('pb') ? 'pb' : has('evEbitda') ? 'evEbitda' : firstOf(forms)
    case 'capital-intensive': case 'yield':
      return has('evEbitda') ? 'evEbitda' : has('pb') ? 'pb' : firstOf(forms)
    default:
      return has('pe') ? 'pe' : has('evEbitda') ? 'evEbitda' : firstOf(forms)
  }
}

export const FORM_LABELS = {
  pe: 'P/E', pb: 'P/B', evEbitda: 'EV/EBITDA', evSales: 'EV/Sales',
}

function firstOf(forms) {
  const k = Object.keys(forms)
  return k.length ? k[0] : null
}

// averagePayoutPct moved to formulas.js so materializeSustainableGrowth can
// use the same table-native fallback chain the Formulas tab shows —
// re-exported here so every existing caller of THIS file needs zero changes.
export { averagePayoutPct } from './formulas.js'
