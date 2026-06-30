/**
 * src/engine/marketExpectation.js
 *
 * "What growth rate is the market betting on?"
 *
 * Three variants depending on what data is available:
 *   1. Sales-based    — for growth/pre-revenue companies (no reliable earnings)
 *   2. Earnings-based — for mature companies with stable profits
 *   3. FCF-based      — for companies with strong free cash flow history
 *
 * Each solves: given current base metric + market cap + terminal multiple +
 * discount rate + horizon, what annual growth rate justifies current market cap?
 *
 * Then shows sanity check: at conservative / base / aggressive / extreme growth,
 * what would the implied market cap be vs current?
 *
 * Default assumptions are justified by sector and stage — not arbitrary.
 */

import { SECTOR_TYPES } from './stage.js'

// ─── Default assumptions by stage + sector ───────────────────────────────────

export function getDefaultAssumptions(stage, sectorType, ratios) {
  // Terminal Sales multiple — what the market will value the company at maturity
  // Based on sector median EV/Sales for mature companies in that sector
  const terminalSalesMultiple = getSalesMultiple(sectorType, ratios)

  // Terminal PE multiple — what earnings multiple a mature company deserves
  const terminalPeMultiple = getPeMultiple(sectorType, ratios)

  // Discount rate — required annual return, reflects risk
  // Growth/pre-revenue = higher risk = higher required return
  const discountRate = stage === 'PRE_REVENUE' ? 0.18
    : stage === 'GROWTH'      ? 0.15
    : stage === 'TRANSITION'  ? 0.13
    : 0.12  // ESTABLISHED

  return {
    terminalSalesMultiple,
    terminalPeMultiple,
    discountRate,
    horizon: 10,
    // Rationale strings shown in ⓘ tooltips
    rationale: {
      terminalSalesMultiple: getMultipleRationale('sales', sectorType, terminalSalesMultiple),
      terminalPeMultiple:    getMultipleRationale('pe',    sectorType, terminalPeMultiple),
      discountRate:          getDiscountRationale(stage, discountRate),
      horizon:               'Standard investment horizon of 10 years. Long enough to smooth out cycles, short enough to be meaningful. Change to 5 years for faster-moving sectors.'
    }
  }
}

function getSalesMultiple(sectorType, ratios) {
  // If we have the stock's actual EV/Revenue, use it as anchor (clamped to reasonable range)
  const actual = ratios?.evRevenue?.value
  if (actual != null && actual > 0) return Math.round(Math.max(1.5, Math.min(actual, 8)) * 2) / 2

  // Otherwise use sector median terminal Sales multiples
  if (sectorType === SECTOR_TYPES.INSURANCE) return 1.5
  if (sectorType === SECTOR_TYPES.BANK)      return 2.0
  if (sectorType === SECTOR_TYPES.NBFC)      return 2.5
  return 3.0  // general default for industrial/consumer/tech
}

function getPeMultiple(sectorType, ratios) {
  const actual = ratios?.pe?.value
  if (actual != null && actual > 0 && actual < 60) return Math.round(actual)
  if (sectorType === SECTOR_TYPES.INSURANCE) return 18
  if (sectorType === SECTOR_TYPES.BANK)      return 16
  if (sectorType === SECTOR_TYPES.NBFC)      return 16
  return 20
}

function getMultipleRationale(type, sectorType, value) {
  if (type === 'sales') {
    return `${value}× Sales is the assumed terminal valuation multiple — what the market will value ` +
      `this company's revenue at once it matures. ` +
      `Lower for asset-heavy/cyclical sectors (1.5-2×), higher for tech/consumer (4-6×). ` +
      `Increase if you believe the company will command a premium at maturity; decrease for commoditised businesses.`
  }
  return `${value}× P/E is the assumed terminal earnings multiple. ` +
    `Reflects what the market typically pays for ₹1 of mature earnings in this sector. ` +
    `Increase for high-quality compounders; decrease for cyclical or capital-intensive businesses.`
}

function getDiscountRationale(stage, rate) {
  const pct = (rate * 100).toFixed(0)
  const risk = stage === 'PRE_REVENUE' ? 'very high (pre-revenue, unproven model)'
    : stage === 'GROWTH'     ? 'high (growth stage, execution uncertainty)'
    : stage === 'TRANSITION' ? 'moderate (approaching profitability)'
    : 'lower (mature, predictable cash flows)'
  return `${pct}% is your required annual return. Risk is ${risk}. ` +
    `Think of this as the minimum return you need to invest here vs a safer alternative. ` +
    `Increase if you want a higher margin of safety; decrease if you trust the business more.`
}

// ─── Core solver ──────────────────────────────────────────────────────────────

/**
 * Solve for implied growth rate given:
 *   baseValue     — current Sales or Net Profit (absolute INR/USD)
 *   marketCap     — current market cap
 *   terminalMult  — what multiple we apply to base metric in year N
 *   discountRate  — required annual return
 *   horizon       — years
 *
 * Formula:
 *   futureMarketCap = baseValue × (1+g)^N × terminalMult
 *   presentValue    = futureMarketCap / (1+discountRate)^N
 *   solve: presentValue = marketCap → find g
 */
function solveImpliedGrowth(baseValue, marketCap, terminalMult, discountRate, horizon) {
  if (!baseValue || !marketCap || baseValue <= 0 || marketCap <= 0) return null

  // Rearrange: g = (marketCap × (1+r)^N / (base × mult))^(1/N) - 1
  const g = Math.pow(
    (marketCap * Math.pow(1 + discountRate, horizon)) / (baseValue * terminalMult),
    1 / horizon
  ) - 1

  return isFinite(g) ? g * 100 : null  // return as percentage
}

/**
 * For a given growth rate, what would the present value (implied market cap) be?
 */
function impliedMarketCap(baseValue, growthRate, terminalMult, discountRate, horizon) {
  const futureBase = baseValue * Math.pow(1 + growthRate / 100, horizon)
  const futureMktCap = futureBase * terminalMult
  return futureMktCap / Math.pow(1 + discountRate, horizon)
}

// ─── Sanity check table ───────────────────────────────────────────────────────

function buildSanityTable(baseValue, marketCap, terminalMult, discountRate, horizon, impliedG) {
  // Build a range of growth rates around the implied rate
  // Always include: conservative, base, implied, aggressive, extreme
  const rates = [5, 10, 15, 20, 25, 30, 35, 40]

  return rates.map(g => {
    const pv = impliedMarketCap(baseValue, g, terminalMult, discountRate, horizon)
    const ratio = pv / marketCap  // >1 means undervalued at this growth
    return {
      growthRate: g,
      impliedPV: pv,
      ratio,
      label: ratio > 1.3 ? 'Undervalued' : ratio > 0.9 ? 'Fair' : ratio > 0.6 ? 'Overvalued' : 'Highly overvalued',
      isCurrentImplied: impliedG != null && Math.abs(g - impliedG) < 2.5
    }
  })
}

// ─── Conclusion text ──────────────────────────────────────────────────────────

function getConclusion(impliedG, historicalGrowth, stage, metricType) {
  if (impliedG == null) return null

  const metric = metricType === 'sales' ? 'sales' : metricType === 'earnings' ? 'earnings' : 'FCF'
  const historical = historicalGrowth != null ? historicalGrowth.toFixed(1) : null

  const category = impliedG > 35 ? 'extreme'
    : impliedG > 25 ? 'aggressive'
    : impliedG > 15 ? 'moderate'
    : impliedG > 8  ? 'conservative'
    : 'very conservative'

  const verdict = impliedG > 35
    ? `This is an extreme growth expectation. Very few companies sustain ${impliedG.toFixed(1)}% ${metric} growth for 10 years. Only invest if you have very strong conviction in the business model.`
    : impliedG > 25
    ? `This is an aggressive growth expectation. Achievable for exceptional businesses but requires consistent execution over a decade. Validate with industry growth rates and competitive position.`
    : impliedG > 15
    ? `This is a moderate growth expectation — challenging but achievable for a well-run company in a growing sector. Compare against the company's historical growth rate.`
    : impliedG > 8
    ? `This is a conservative growth expectation. If you believe the company can grow ${metric} at ${impliedG.toFixed(1)}%/yr, the current price may offer value.`
    : `The market is pricing in low growth. Either the market is pessimistic, or the company faces structural headwinds. Investigate which before investing.`

  const histContext = historical
    ? ` Historical ${metric} CAGR: ${historical}% — market expects ${impliedG > parseFloat(historical) ? 'acceleration' : 'deceleration'} from this.`
    : ''

  return `Market is pricing in ~${impliedG.toFixed(1)}% annual ${metric} growth for ${10} years (${category}). ${verdict}${histContext}`
}

// ─── Main function ────────────────────────────────────────────────────────────

export function runMarketExpectation(data, ratioResult, stage, sectorType, overrides = {}) {
  const r   = ratioResult
  const defaults = getDefaultAssumptions(stage, sectorType, r?.ratios)
  const assumptions = { ...defaults, ...overrides }
  const { terminalSalesMultiple, terminalPeMultiple, discountRate, horizon } = assumptions

  const price     = r?.price
  const marketCap = r?.marketCap
  const revenue   = r?.revenue
  const netProfit = r?.netProfit
  const fcf       = r?.fcf > 0 ? r.fcf : null
  const opCF      = r?.opCF > 0 ? r.opCF * 0.7 : null  // haircut as FCF proxy

  const historicalRevGrowth = r?.ratios?.revCagr?.value
  const historicalNPGrowth  = r?.ratios?.npGrowthYoY?.value

const isFinancial = ['insurance', 'bank', 'nbfc'].includes(sectorType)

  const variants = {}

  // ── Sales-based ─────────────────────────────────────────────────────────────
  if (revenue != null && revenue > 0 && marketCap) {
    const impliedG = solveImpliedGrowth(revenue, marketCap, terminalSalesMultiple, discountRate, horizon)
    const sanity   = impliedG != null
      ? buildSanityTable(revenue, marketCap, terminalSalesMultiple, discountRate, horizon, impliedG)
      : null

    variants.sales = {
      applicable: true,
      label: 'Sales-based',
      note: isFinancial
        ? 'For banks/insurers, Sales = Net Interest Income / Premium Income — used here as the cross-check method since Net Profit or FCF analysis may be unavailable or structurally negative for this sector.'
        : 'Best for growth/pre-profit companies. Uses revenue as base.',
      base: revenue,
      baseLabel: 'Current Sales',
      terminalMultiple: terminalSalesMultiple,
      terminalMultipleLabel: `${terminalSalesMultiple}× Sales`,
      impliedGrowth: impliedG,
      sanityTable: sanity,
      conclusion: getConclusion(impliedG, historicalRevGrowth, stage, 'sales'),
      assumptions: {
        terminalMultiple: { value: terminalSalesMultiple, rationale: assumptions.rationale.terminalSalesMultiple },
        discountRate:     { value: discountRate,          rationale: assumptions.rationale.discountRate },
        horizon:          { value: horizon,                rationale: assumptions.rationale.horizon }
      }
    }
  } else {
    variants.sales = {
      applicable: false,
      reason: revenue == null ? 'Revenue data not available' : 'Revenue is zero or negative'
    }
  }

  // ── Earnings-based ──────────────────────────────────────────────────────────
  if (netProfit != null && netProfit > 0 && marketCap) {
    const impliedG = solveImpliedGrowth(netProfit, marketCap, terminalPeMultiple, discountRate, horizon)
    const sanity   = impliedG != null
      ? buildSanityTable(netProfit, marketCap, terminalPeMultiple, discountRate, horizon, impliedG)
      : null

    variants.earnings = {
      applicable: true,
      label: 'Earnings-based',
      note: isFinancial
        ? 'Recommended primary method for banks/insurers — Net Profit is the most reliable base metric for this sector.'
        : 'Best for mature profitable companies. Uses Net Profit as base.',
      base: netProfit,
      baseLabel: 'Current Net Profit',
      terminalMultiple: terminalPeMultiple,
      terminalMultipleLabel: `${terminalPeMultiple}× P/E`,
      impliedGrowth: impliedG,
      sanityTable: sanity,
      conclusion: getConclusion(impliedG, historicalNPGrowth, stage, 'earnings'),
      assumptions: {
        terminalMultiple: { value: terminalPeMultiple, rationale: assumptions.rationale.terminalPeMultiple },
        discountRate:     { value: discountRate,        rationale: assumptions.rationale.discountRate },
        horizon:          { value: horizon,              rationale: assumptions.rationale.horizon }
      }
    }
  } else {
    variants.earnings = {
      applicable: false,
      reason: netProfit == null ? 'Net Profit data not available'
        : netProfit <= 0 ? 'Company is loss-making — earnings-based method not applicable'
        : 'Insufficient data'
    }
  }

  // ── FCF-based ────────────────────────────────────────────────────────────────
  const fcfBase = fcf ?? opCF
  if (fcfBase != null && fcfBase > 0 && marketCap) {
    // For FCF we use EV/FCF terminal multiple — typically 15-25×
    const termFcfMult = 18
    const impliedG = solveImpliedGrowth(fcfBase, marketCap, termFcfMult, discountRate, horizon)
    const sanity   = impliedG != null
      ? buildSanityTable(fcfBase, marketCap, termFcfMult, discountRate, horizon, impliedG)
      : null

    variants.fcf = {
      applicable: true,
      label: 'FCF-based',
      note: fcf ? 'Uses Free Cash Flow — most precise for cash-generative businesses.'
                : 'Uses Operating CF × 0.7 as FCF proxy (actual FCF not available).',
      base: fcfBase,
      baseLabel: fcf ? 'Free Cash Flow' : 'Operating CF (×0.7 proxy)',
      terminalMultiple: termFcfMult,
      terminalMultipleLabel: `${termFcfMult}× FCF`,
      impliedGrowth: impliedG,
      sanityTable: sanity,
      conclusion: getConclusion(impliedG, historicalRevGrowth, stage, 'FCF'),
      assumptions: {
        terminalMultiple: {
          value: termFcfMult,
          rationale: `${termFcfMult}× FCF is the assumed terminal FCF multiple — what the market will pay per rupee of free cash flow at maturity. Mature cash-generative businesses typically trade at 15-25× FCF. Increase for high-quality, low-capex businesses; decrease for capital-intensive ones.`
        },
        discountRate: { value: discountRate, rationale: assumptions.rationale.discountRate },
        horizon:      { value: horizon,       rationale: assumptions.rationale.horizon }
      }
    }
  } else {
    variants.fcf = {
      applicable: false,
      reason: (fcf != null && fcf <= 0) || (r?.opCF != null && r.opCF <= 0)
        ? (isFinancial
            ? 'Operating CF is negative — this is structurally normal for banks/insurers (loan disbursements count as operating outflow) and does not indicate financial distress. Use Earnings-based instead.'
            : 'FCF and Operating CF are negative — FCF-based method not applicable')
        : 'Cash flow data not available'
    }
  }

  return { variants, assumptions, marketCap, price }
}
