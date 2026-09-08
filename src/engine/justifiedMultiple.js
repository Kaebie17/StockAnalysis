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

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)

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
 * Present value of a two-stage stream, expressed as a multiple.
 *
 * Used when g >= r, where the single-stage formula divides by zero or turns
 * negative. That isn't a flaw to work around — it's the model correctly refusing
 * an impossible assumption, since no company outgrows its discount rate forever.
 */
function twoStageMultiple({ payout, g, r, roe, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null

  // Stage 1: dividends at the CURRENT payout, growing at g.
  let pv = 0
  let dividend = payout
  for (let t = 1; t <= years; t++) {
    dividend *= (1 + g)
    pv += dividend / Math.pow(1 + r, t)
  }

  // Terminal: the payout RISES when growth fades.
  //
  // Holding it at the current rate was the error here: a company growing 25%
  // retains almost everything, but one growing 6% only needs to retain g/ROE to
  // fund that growth and pays out the rest. Freezing a 10% payout into
  // perpetuity valued a compounder at 2.6x earnings — it counted the dividends
  // and ignored what the retained earnings were building.
  const terminalPayout = (roe > 0 && roe > terminalG)
    ? Math.max(0, Math.min(1, 1 - terminalG / roe))
    : payout
  const earningsAtT = Math.pow(1 + g, years)          // per unit of current earnings
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
function twoStageEvMultiple({ conversion, g, r, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null

  // Stage 1: cash reaching investors, per unit of TODAY's EBITDA/revenue,
  // growing at g.
  let pv = 0
  let cf = conversion
  for (let t = 1; t <= years; t++) {
    cf *= (1 + g)
    pv += cf / Math.pow(1 + r, t)
  }

  // Terminal: EBITDA/revenue has grown by (1+g)^years by the time growth
  // fades — the terminal value sits on THAT larger base, discounted back from
  // year 5, mirroring earningsAtT above.
  const baseAtT = Math.pow(1 + g, years)   // per unit of today's EBITDA/revenue
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
 * the first place, just solved for the other variable). That's what lets
 * this stay payout-data-free, like the single-stage P/B form already is.
 */
function twoStagePbMultiple({ roe, g, r, years = STAGE_1_YEARS, terminalG }) {
  if (!(r > terminalG)) return null
  const roeDec = roe / 100
  if (!(roeDec > 0)) return null
  const payout = Math.max(0, Math.min(1, 1 - g / roeDec))

  // Stage 1: dividends at the implied payout, per unit of TODAY's book value.
  // Book value at the START of year t earns ROE that year; what isn't paid
  // out is retained and grows next year's book base.
  let pv = 0
  let bookAtStart = 1   // per unit of today's book value
  for (let t = 1; t <= years; t++) {
    const dividend = bookAtStart * roeDec * payout
    pv += dividend / Math.pow(1 + r, t)
    bookAtStart *= (1 + g)
  }

  // Terminal: bookAtStart already IS the book value at the START of the
  // terminal year (year `years`+1) — the loop above updates it AFTER each
  // dividend is taken, so by the time it exits, bookAtStart has already
  // compounded one step past the last explicit stage-1 dividend. Earnings for
  // that terminal year are bookAtStart x ROE directly; no extra (1+terminalG)
  // step is needed here (unlike twoStageMultiple's P/E form, whose `earningsAtT`
  // is deliberately computed as the level AT year `years`, one step short of
  // the terminal year, and does need that step). Multiplying by (1+terminalG)
  // here was a copy-paste of that P/E shape onto a variable with a different
  // convention — it silently overstated the terminal component (and so the
  // whole two-stage P/B multiple) by a factor of (1+terminalG), confirmed by
  // checking that the correct decomposition exactly reproduces the known-good
  // single-stage formula (ROE-g)/(r-g) when g == terminalG.
  const terminalPayout = (roeDec > terminalG) ? Math.max(0, Math.min(1, 1 - terminalG / roeDec)) : payout
  const terminal = (bookAtStart * roeDec * terminalPayout) / (r - terminalG)
  pv += terminal / Math.pow(1 + r, years)
  return pv
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
  const { riskFreeRate, equityRiskPremium, beta, betaMeta = null, incomeHistory = [], market = 'IN' } = opts
  const R = ratioResult?.ratios || {}

  const roe = R.roe?.value
  const payoutPct = R.dividendPayout?.value ?? averagePayoutPct(incomeHistory, {
    cashflowHistory: opts.cashflowHistory || [],
    dividendYield: R.dividendYield?.value ?? null,
    pe: R.pe?.value ?? null,
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

  // P/E — a company paying nothing has a justified P/E of zero under the
  // single-stage formula, which is a limitation of the FORM rather than a
  // valuation. Those are better served by P/B, so this returns nothing.
  if (payoutPct > 0) {
    const payout = payoutPct / 100
    const pe = twoStage ? twoStageMultiple({ payout, g, r, roe: roe / 100, terminalG })
                        : (payout * (1 + g)) / (r - g)
    if (pe > 0 && isFinite(pe)) {
      forms.pe = {
        multiple: round(pe, 1), basis: 'pe', tier: TIER.DERIVED,
        label: twoStage ? 'Justified P/E (two-stage)' : 'Justified P/E',
        steps: twoStage
          ? [`Growth ${round(g * 100, 1)}% exceeds the ${round(r * 100, 1)}% required return, so it is modelled`,
             `explicitly for ${STAGE_1_YEARS} years then faded to ${round(terminalG * 100, 1)}%`,
             `Payout rises from ${round(payoutPct, 0)}% to ${round((1 - terminalG / (roe / 100)) * 100, 0)}% once growth slows`,
             `— a company that stops reinvesting pays out what it no longer needs`]
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
      ? twoStagePbMultiple({ roe, g, r, terminalG })
      : (r - g > 0 ? (roeDec - g) / (r - g) : null)
    if (pb > 0 && isFinite(pb)) {
      forms.pb = {
        multiple: round(pb, 2), basis: 'pb', tier: TIER.DERIVED,
        label: twoStage ? 'Justified P/B (two-stage)' : 'Justified P/B',
        steps: twoStage
          ? [`Growth ${round(g * 100, 1)}% exceeds the ${round(r * 100, 1)}% required return, so it is modelled`,
             `explicitly for ${STAGE_1_YEARS} years then faded to ${round(terminalG * 100, 1)}%`,
             `Implied payout rises as growth fades, same as the Justified P/E basis`]
          : [`(ROE ${round(roe, 1)}% - growth ${round(g * 100, 1)}%) / (required ${round(r * 100, 1)}% - growth ${round(g * 100, 1)}%)`,
             roeDec > r ? 'Earning above its cost of equity, so worth more than book.'
                        : 'Earning below its cost of equity, so worth less than book.'],
      }
    }
  }

  // EV/EBITDA — for businesses whose depreciation makes net profit
  // uninformative. Same present-value logic on the cash the assets throw off.
  const ebitda = ratioResult?.ebitda ?? R.ebitda?.value
  const revenue = ratioResult?.revenue
  if (ebitda > 0 && revenue > 0) {
    // Share of EBITDA reaching investors after tax and reinvestment. Prefer
    // this company's own MEASURED FCF/EBITDA conversion (real capex and real
    // tax already baked in) over a guess — `1 - retention x 0.5` was an
    // invented halving with no derivation behind it, kept now only as the
    // fallback for when FCF genuinely isn't available. No bound on the
    // measured case: a real, differentiated business (near-zero-capex
    // software vs. heavy-capex manufacturing) can legitimately sit anywhere
    // in a wide range, and clamping a real measured ratio to fit an assumed
    // band replaces real data with a guess. The estimated fallback keeps a
    // sanity floor only against nonsense (a retention outside [0,1] would
    // otherwise produce a negative or >100% conversion), not a plausibility
    // judgment about what's "too high" or "too low" for this business.
    const measuredConversion = (ratioResult?.fcf > 0) ? ratioResult.fcf / ebitda : null
    const conversion = measuredConversion != null
      ? measuredConversion
      : Math.max(0, Math.min(1, retention > 0 ? 1 - retention * 0.5 : 0.5))
    const evEbitda = twoStage
      ? twoStageEvMultiple({ conversion, g, r, terminalG })
      : (r - g > 0 ? conversion / (r - g) : null)
    if (evEbitda > 0 && isFinite(evEbitda)) {
      forms.evEbitda = {
        multiple: round(evEbitda, 1), basis: 'evEbitda',
        // DERIVED when the real measured FCF/EBITDA ratio anchors it;
        // ASSUMED when the estimated-fallback conversion is used — the
        // comment above already calls that "an invented halving with no
        // derivation behind it."
        tier: measuredConversion != null ? TIER.DERIVED : TIER.ASSUMED,
        label: twoStage ? 'Justified EV/EBITDA (two-stage)' : 'Justified EV/EBITDA',
        steps: twoStage
          ? [`Growth ${round(g * 100, 1)}% exceeds the ${round(r * 100, 1)}% required return, so it is modelled`,
             `explicitly for ${STAGE_1_YEARS} years then faded to ${round(terminalG * 100, 1)}%`,
             `${round(conversion * 100, 0)}% of EBITDA reaching investors (${measuredConversion != null ? 'this company\'s own measured FCF/EBITDA' : 'estimated — FCF not available'}), applied to EBITDA at each stage`]
          : [`${round(conversion * 100, 0)}% of EBITDA reaching investors (${measuredConversion != null ? 'this company\'s own measured FCF/EBITDA' : 'estimated — FCF not available'}) / (${round(r * 100, 1)}% required - ${round(g * 100, 1)}% growth)`,
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
      ? twoStageEvMultiple({ conversion, g, r, terminalG })
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
          ? [`Growth ${round(g * 100, 1)}% exceeds the ${round(r * 100, 1)}% required return, so it is modelled`,
             `explicitly for ${STAGE_1_YEARS} years then faded to ${round(terminalG * 100, 1)}%`,
             `Net margin ${round(netMargin, 1)}%, applied to revenue at each stage`]
          : [`Net margin ${round(netMargin, 1)}% / (${round(r * 100, 1)}% - ${round(g * 100, 1)}%)`],
      }
    }
  }

  return {
    available: Object.keys(forms).length > 0,
    forms, missing,
    requiredReturn: rr,
    growth: { g, gPct: round(g * 100, 1), retention, roe, payoutPct },
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

/**
 * Payout from whatever the statements actually carry.
 *
 * The first version read only `dividendPaid` on the income rows, which most
 * sources don't provide — so a company with a perfectly visible dividend
 * reported "missing dividend payout history" and Estimate 1 declined. Every
 * route to the same figure is tried before giving up:
 *
 *   1. dividend paid, from the income statement
 *   2. dividend paid, from the cash flow statement (where it usually lives)
 *   3. dividend per share ÷ EPS, which needs no absolute figures at all
 *   4. the trailing dividend yield against the P/E, the last resort
 */
export function averagePayoutPct(history = [], opts = {}) {
  const rates = []
  for (const row of history || []) {
    const np = val(row?.netProfit)
    const div = val(row?.dividendPaid) ?? val(row?.dividend) ?? val(row?.dividendsPaid)
    if (np > 0 && div >= 0) {
      const pct = (Math.abs(div) / np) * 100
      if (pct >= 0 && pct <= 100) rates.push(pct)
    }
    // Per-share route — often present where absolutes aren't.
    const dps = val(row?.dps) ?? val(row?.dividendPerShare)
    const eps = val(row?.eps)
    if (rates.length === 0 && dps >= 0 && eps > 0) {
      const pct = (dps / eps) * 100
      if (pct >= 0 && pct <= 100) rates.push(pct)
    }
  }

  // Cash-flow statement, where dividends paid are normally reported.
  if (rates.length === 0) {
    for (const row of opts.cashflowHistory || []) {
      const div = Math.abs(val(row?.dividendsPaid) ?? val(row?.dividendPaid) ?? 0)
      const y = String(row?.year ?? '')
      const inc = (history || []).find(r => String(r?.year ?? '') === y)
      const np = val(inc?.netProfit)
      if (div > 0 && np > 0) {
        const pct = (div / np) * 100
        if (pct >= 0 && pct <= 100) rates.push(pct)
      }
    }
  }

  // Yield × P/E is the payout ratio, arithmetically — usable when the
  // statements carry neither figure but the quote does.
  if (rates.length === 0 && opts.dividendYield > 0 && opts.pe > 0) {
    const pct = opts.dividendYield * opts.pe
    if (pct > 0 && pct <= 100) rates.push(pct)
  }

  if (rates.length === 0) return null
  rates.sort((a, b) => a - b)
  return rates[Math.floor(rates.length / 2)]
}
