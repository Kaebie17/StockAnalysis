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

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)

// Terminal growth cannot exceed the economy forever — a company growing faster
// than nominal GDP in perpetuity eventually becomes the economy. India's
// long-run nominal growth is the ceiling used when a two-stage model fades.
const TERMINAL_GROWTH_CAP = 0.06

// Explicit high-growth window before the fade. Five to ten years is the usual
// range in practice; the shorter end is used because a longer window compounds
// an assumed rate further.
const STAGE_1_YEARS = 5

/**
 * Required return on equity — CAPM.
 *   r = risk-free + beta x equity risk premium
 * Beta is measured from price history where available; the equity risk premium
 * is the one genuine assumption here and is surfaced rather than buried.
 */
export function requiredReturn({ riskFreeRate, beta, equityRiskPremium = 0.065 } = {}) {
  if (!(riskFreeRate > 0)) return null
  const b = (beta > 0 && beta < 3) ? beta : 1     // an implausible beta is worse than none
  const r = riskFreeRate + b * equityRiskPremium
  return {
    r, beta: b, betaAssumed: !(beta > 0 && beta < 3),
    riskFreeRate, equityRiskPremium,
    label: `${round(riskFreeRate * 100, 1)}% risk-free + ${round(b, 2)} beta x ${round(equityRiskPremium * 100, 1)}% premium`,
  }
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
function twoStageMultiple({ payout, g, r, roe, years = STAGE_1_YEARS, terminalG = TERMINAL_GROWTH_CAP }) {
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
 * Every justified multiple the inputs can support. Returns null for a form whose
 * inputs are missing rather than substituting a value — a blank with a stated
 * reason is more useful than a number nobody can trace.
 */
export function justifiedMultiples(ratioResult, opts = {}) {
  const { riskFreeRate, equityRiskPremium, beta, incomeHistory = [] } = opts
  const R = ratioResult?.ratios || {}

  const roe = R.roe?.value
  const payoutPct = R.dividendPayout?.value ?? averagePayoutPct(incomeHistory, {
    cashflowHistory: opts.cashflowHistory || [],
    dividendYield: R.dividendYield?.value ?? null,
    pe: R.pe?.value ?? null,
  })
  const rr = requiredReturn({ riskFreeRate, beta, equityRiskPremium })
  const sg = sustainableGrowth({ roe, payoutPct })

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
    const pe = twoStage ? twoStageMultiple({ payout, g, r, roe: roe / 100 })
                        : (payout * (1 + g)) / (r - g)
    if (pe > 0 && isFinite(pe)) {
      forms.pe = {
        multiple: round(pe, 1), basis: 'pe',
        label: twoStage ? 'Justified P/E (two-stage)' : 'Justified P/E',
        steps: twoStage
          ? [`Growth ${round(g * 100, 1)}% exceeds the ${round(r * 100, 1)}% required return, so it is modelled`,
             `explicitly for ${STAGE_1_YEARS} years then faded to ${round(TERMINAL_GROWTH_CAP * 100, 1)}%`,
             `Payout rises from ${round(payoutPct, 0)}% to ${round((1 - TERMINAL_GROWTH_CAP / (roe / 100)) * 100, 0)}% once growth slows`,
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
    const gUsed = twoStage ? TERMINAL_GROWTH_CAP : g
    const pb = (roeDec - gUsed) / (r - gUsed)
    if (pb > 0 && isFinite(pb)) {
      forms.pb = {
        multiple: round(pb, 2), basis: 'pb',
        label: twoStage ? 'Justified P/B (faded growth)' : 'Justified P/B',
        steps: [`(ROE ${round(roe, 1)}% - growth ${round(gUsed * 100, 1)}%) / (required ${round(r * 100, 1)}% - growth ${round(gUsed * 100, 1)}%)`,
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
    const gUsed = twoStage ? TERMINAL_GROWTH_CAP : g
    const denom = r - gUsed
    // Share of EBITDA reaching investors after tax and reinvestment, bounded
    // because an unbounded conversion would swing the multiple wildly.
    const conversion = Math.max(0.25, Math.min(0.75, retention > 0 ? 1 - retention * 0.5 : 0.5))
    if (denom > 0) {
      const evEbitda = conversion / denom
      if (evEbitda > 0 && isFinite(evEbitda)) {
        forms.evEbitda = {
          multiple: round(evEbitda, 1), basis: 'evEbitda', label: 'Justified EV/EBITDA',
          steps: [`${round(conversion * 100, 0)}% of EBITDA reaching investors / (${round(r * 100, 1)}% required - ${round(gUsed * 100, 1)}% growth)`,
                  `EBITDA margin ${round((ebitda / revenue) * 100, 1)}%`],
        }
      }
    }
  }

  // EV/Sales — last resort, for companies with no positive earnings. Weak by
  // construction: it prices revenue without knowing whether it converts to cash.
  const netMargin = R.netMargin?.value
  if (netMargin > 0 && revenue > 0) {
    const gUsed = twoStage ? TERMINAL_GROWTH_CAP : g
    const denom = r - gUsed
    if (denom > 0) {
      const evSales = (netMargin / 100) / denom
      if (evSales > 0 && isFinite(evSales)) {
        forms.evSales = {
          multiple: round(evSales, 2), basis: 'evSales', label: 'Justified EV/Sales',
          steps: [`Net margin ${round(netMargin, 1)}% / (${round(r * 100, 1)}% - ${round(gUsed * 100, 1)}%)`],
        }
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
    terminalGrowthPct: twoStage ? round(TERMINAL_GROWTH_CAP * 100, 1) : null,
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
