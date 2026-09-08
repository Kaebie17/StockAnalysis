
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
import { capmCostOfEquity, DEFAULT_RISK_FREE_BY_MARKET, TERMINAL_GROWTH_BY_MARKET } from './requiredReturn.js'
import { sectorPe, sectorEvSales, sectorEvFcf, financialPe, financialSales } from './sectorMultiples.js'
import { reverseDcfGrowth, computeWacc } from './valuation.js'
import { TIER } from './methodologyTier.js'

// ─── Default assumptions by stage + sector ───────────────────────────────────

// opts.{liveRiskFree, beta, market}: threaded from AppContext's shared fetch
// (Phase 8) — null until that resolves, which is fine, this always falls back
// to a usable default. This used to be a flat 4-bucket stage table (12/13/15/
// 18%) that wasn't CAPM at all and ignored the company's own beta entirely —
// the SAME company could get a materially different "required return" here
// than valuation.js's WACC computed for the exact same moment. Discount rate
// stays user-adjustable via its existing slider; only the DEFAULT changes.
//
// `data` (added here) is what lets the sector-table fallback below use the
// SAME granular, ~15-bucket table valuation.js already had — this file used
// to only receive the coarse sectorType enum (bank/nbfc/insurance/default)
// and fell back to one flat number for every other sector: tech, FMCG,
// steel, auto all got the identical "20× P/E, 3.0× sales" default despite
// valuation.js already knowing better for every one of them.
export function getDefaultAssumptions(stage, sectorType, ratios, data = null, opts = {}) {
  // Terminal Sales multiple — what the market will value the company at maturity
  // Based on sector median EV/Sales for mature companies in that sector
  const salesResult = getSalesMultiple(sectorType, ratios, data)
  const terminalSalesMultiple = salesResult.value

  // Terminal PE multiple — what earnings multiple a mature company deserves
  const peResult = getPeMultiple(sectorType, ratios, data)
  const terminalPeMultiple = peResult.value

  const market = opts.market ?? 'IN'
  const riskFree = opts.liveRiskFree ?? DEFAULT_RISK_FREE_BY_MARKET[market] ?? DEFAULT_RISK_FREE_BY_MARKET.IN
  const capm = capmCostOfEquity({ riskFreeRate: riskFree, beta: opts.beta, erp: opts.liveErp ?? null, market, betaMeta: opts.betaMeta ?? null })
  const discountRate = capm.r   // pure cost of equity — correct for the Earnings-based variant, which solves against a bare EQUITY target (marketCap).

  // Sales-based, FCF-based and Reverse-DCF all solve against an ENTERPRISE
  // value target (marketCap + net debt) — discounting that at pure cost of
  // equity was a units mismatch (WACC blends in the cheaper, tax-shielded
  // cost of debt; Ke alone overstates the firm-level discount rate whenever
  // there's meaningful debt). Reuses valuation.js's own computeWacc() rather
  // than writing a second, independently-maintained WACC formula here.
  // opts.ratioResult is the FULL ratioResult (not just .ratios) — computeWacc
  // needs marketCap/totalDebt/interest/cash, which live at that top level.
  const waccResult = computeWacc(opts.ratioResult, {
    liveRiskFree: riskFree, market, erp: opts.liveErp ?? null, beta: opts.beta, betaMeta: opts.betaMeta ?? null,
  })
  // Falls back to the pure cost of equity when a real WACC can't be computed
  // (debt is present but interest expense isn't reported) — decline
  // gracefully to the nearest real number available, don't fabricate a
  // blended rate from nothing.
  const enterpriseDiscountRate = waccResult.wacc ?? discountRate

  // Terminal FCF multiple — was a single flat 18x for every sector alike (and
  // before that, hardcoded inline in the FCF variant with no override path at
  // all). Now anchors on the stock's own actual FCF conversion when a usable
  // one exists, else the sector median table (same two-tier pattern as the
  // Sales/P/E multiples above).
  const fcfResult = getFcfMultiple(sectorType, ratios, data)
  const terminalFcfMultiple = fcfResult.value

  // Shared disclosure: every terminal multiple here defaults to this
  // company's OWN current multiple as a proxy for what it'll trade at once
  // mature — a common, defensible reverse-DCF simplification, but not a
  // free one. If today's multiple is elevated BECAUSE the market already
  // expects high growth, using it as the maturity/exit multiple too
  // partially bakes that same growth premium into the terminal assumption,
  // which can UNDERSTATE the growth actually being priced in.
  const currentMultipleCaveat = ' Uses this company\'s own current multiple as a proxy for its multiple at maturity — if today\'s multiple is already elevated because the market expects high growth, this can understate how much growth is really being priced in.'

  return {
    terminalSalesMultiple,
    terminalPeMultiple,
    terminalFcfMultiple,
    discountRate,
    enterpriseDiscountRate,
    horizon: 10,
    // DERIVED when the stock's own actual ratio anchors the multiple; ASSUMED
    // when it falls to the sector/financial table. discountRate and
    // enterpriseDiscountRate are always DERIVED — CAPM/WACC applied to real
    // inputs, no asserted constant in the chain. horizon carries no tier —
    // a structural modeling choice, not a value.
    tiers: {
      terminalSalesMultiple: salesResult.tier,
      terminalPeMultiple:    peResult.tier,
      terminalFcfMultiple:   fcfResult.tier,
      discountRate:          TIER.DERIVED,
      enterpriseDiscountRate: TIER.DERIVED,
    },
    // Rationale strings shown in ⓘ tooltips
    rationale: {
      terminalSalesMultiple: getMultipleRationale('sales', sectorType, terminalSalesMultiple) +
        (salesResult.tier === TIER.DERIVED ? currentMultipleCaveat : ''),
      terminalPeMultiple:    getMultipleRationale('pe',    sectorType, terminalPeMultiple) +
        (peResult.tier === TIER.DERIVED ? currentMultipleCaveat : ''),
      terminalFcfMultiple:   `${terminalFcfMultiple}× FCF is the assumed terminal FCF multiple — what the market will pay per rupee of free cash flow at maturity, anchored on this company's own current FCF conversion where measurable, else this sector's typical range. Asset-light, high-conversion sectors (tech, FMCG, pharma) trade richest; capital-intensive sectors (telecom, power, energy) trade lowest. Increase for high-quality, low-capex businesses; decrease for capital-intensive ones.` +
        (fcfResult.tier === TIER.DERIVED ? currentMultipleCaveat : ''),
      discountRate:           getDiscountRationale(stage, discountRate, capm),
      enterpriseDiscountRate: getWaccRationale(enterpriseDiscountRate, waccResult, discountRate),
      horizon:               'Standard investment horizon of 10 years. Long enough to smooth out cycles, short enough to be meaningful. Change to 5 years for faster-moving sectors.'
    }
  }
}

function getSalesMultiple(sectorType, ratios, data) {
  // Real EV/Revenue, used as-is (rounded to the nearest 0.5) — never
  // clamped to a band. This used to clamp to [1.5, 8] while still labeling
  // the (silently substituted) boundary value DERIVED, as if it were the
  // real, unmodified figure — exactly the "the model prefers a different
  // number than reality gave it" mistake this codebase removes everywhere
  // else (beta, WACC, targetMultiple's range). Same gate getPeMultiple/
  // getFcfMultiple already use instead: decline to the sector fallback when
  // the reading is too extreme to trust as a proxy for what this company
  // will trade at once mature, rather than distorting the real number.
  const actual = ratios?.evRevenue?.value
  if (actual != null && actual > 0 && actual < 20) return { value: Math.round(actual * 2) / 2, tier: TIER.DERIVED }

  // Sector median, from the SAME shared table valuation.js uses. Financial
  // sub-types read from sectorMultiples.js's own FINANCIAL_SALES_BY_SECTOR_TYPE
  // (indexed by the already-resolved sectorType, not text-matched) instead of
  // retyping the same numbers here a second time — this file used to carry
  // its own separate copy that happened to agree, with nothing keeping the
  // two in sync if either changed. Both branches here are ASSUMED — flat
  // asserted numbers, no external anchor.
  const isFinancial = [SECTOR_TYPES.INSURANCE, SECTOR_TYPES.BANK, SECTOR_TYPES.NBFC].includes(sectorType)
  return { value: isFinancial ? financialSales(sectorType) : sectorEvSales(data), tier: TIER.ASSUMED }
}

function getPeMultiple(sectorType, ratios, data) {
  const actual = ratios?.pe?.value
  if (actual != null && actual > 0 && actual < 60) return { value: Math.round(actual), tier: TIER.DERIVED }
  const isFinancial = [SECTOR_TYPES.INSURANCE, SECTOR_TYPES.BANK, SECTOR_TYPES.NBFC].includes(sectorType)
  return { value: isFinancial ? financialPe(sectorType) : sectorPe(data), tier: TIER.ASSUMED }
}

// EV/FCF anchor — same two-tier pattern as Sales/P/E above: the stock's own
// actual FCF conversion first (via fcfYield, FCF/MarketCap — the same rough,
// not EV-adjusted, precision the "actual" tier already has for Sales/P/E
// above), sector median EV/FCF table (sectorMultiples.js) otherwise. Was
// previously a single flat 18x for every sector alike, with no per-company
// anchor tier at all.
function getFcfMultiple(sectorType, ratios, data) {
  const fcfYield = ratios?.fcfYield?.value
  const actual = (fcfYield != null && fcfYield > 0) ? 100 / fcfYield : null
  if (actual != null && actual > 0 && actual < 50) return { value: Math.round(actual), tier: TIER.DERIVED }
  return { value: sectorEvFcf(data), tier: TIER.ASSUMED }
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

function getDiscountRationale(stage, rate, capm) {
  const pct = (rate * 100).toFixed(0)
  const stageNote = stage === 'PRE_REVENUE' ? ' Pre-revenue, unproven model — treat this as a floor, not a ceiling.'
    : stage === 'GROWTH'     ? ' Growth stage carries real execution uncertainty beyond what beta alone captures.'
    : stage === 'TRANSITION' ? ' Approaching profitability — moderate risk.'
    : ''
  const basis = capm?.label ? ` (${capm.label})` : ''
  return `${pct}% is your required annual return${basis}.${stageNote} ` +
    `Think of this as the minimum return you need to invest here vs a safer alternative. ` +
    `Increase if you want a higher margin of safety; decrease if you trust the business more.`
}

// Sales-based, FCF-based and Reverse-DCF solve against an ENTERPRISE value
// target (market cap + net debt), not bare equity — this needs the blended
// cost of capital (WACC), not the pure cost of equity the Earnings-based
// variant correctly uses for its equity-only target. Named and rationale'd
// separately so the ⓘ tooltip says which rate is which, rather than the
// same "your required return" text implying both are the same number.
function getWaccRationale(rate, waccResult, ke) {
  const pct = (rate * 100).toFixed(1)
  if (waccResult.wacc == null) {
    return `${pct}% — WACC couldn't be computed (debt is present but interest expense isn't reported), ` +
      `so this falls back to the pure cost of equity (${(ke * 100).toFixed(1)}%) used elsewhere in this panel.`
  }
  return `${pct}% is this company's blended cost of capital (WACC) — equity and debt weighted by their ` +
    `market values, debt's cost tax-shielded. Used here rather than the pure cost of equity because this ` +
    `variant solves against an ENTERPRISE value target (market cap + net debt), not bare equity — discounting ` +
    `a firm-level value at cost of equity alone would overstate the rate whenever there's meaningful debt.`
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

export function runMarketExpectation(data, ratioResult, stage, sectorType, overrides = {}, opts = {}) {
  const r   = ratioResult
  const defaults = getDefaultAssumptions(stage, sectorType, r?.ratios, data, {
    liveRiskFree: opts.liveRiskFree ?? null,
    liveErp: opts.liveErp ?? null,
    beta: opts.beta ?? r?.ratios?.beta?.value ?? null,
    betaMeta: opts.betaMeta ?? null,
    market: opts.market ?? 'IN',
    ratioResult: r,   // computeWacc needs the FULL ratioResult (marketCap/totalDebt/interest/cash), not just .ratios
  })
  const assumptions = { ...defaults, ...overrides }
  const { terminalSalesMultiple, terminalPeMultiple, discountRate, horizon } = assumptions
  // A manual override is one shared "required return" concept from the
  // user's side (the panel's single discount-rate slider) — when set, it
  // replaces BOTH rates uniformly. Left un-overridden, the two deliberately
  // differ: discountRate (Ke) for the equity-target Earnings variant,
  // enterpriseDiscountRate (WACC) for the enterprise-value-target Sales/
  // FCF/Reverse-DCF variants — see getDefaultAssumptions.
  const enterpriseDiscountRate = overrides.discountRate ?? defaults.enterpriseDiscountRate

  const price     = r?.price
  const marketCap = r?.marketCap
  const revenue   = r?.revenue
  const netProfit = r?.netProfit
  const fcf       = r?.fcf > 0 ? r.fcf : null
  const opCF      = null   // was `r.opCF * 0.7` — an invented capex assumption
                           // dressed up as a fair-value input. FCF or nothing.

  const historicalRevGrowth = r?.ratios?.revCagr?.value
  // EV target for the EV/Sales variant (equity market cap ignores net debt, which
  // overstates sales-implied growth for levered firms). Earnings uses P/E → equity.
  const evTarget = (marketCap != null && r?.netDebt != null) ? marketCap + r.netDebt : null
  // npCagr, not npGrowthYoY — getConclusion() below labels this "Historical
  // earnings CAGR", but npGrowthYoY is one year's change, not a multi-year
  // compound rate, and never moved when the growth-window slider did.
  const historicalNPGrowth  = r?.ratios?.npCagr?.value

const isFinancial = ['insurance', 'bank', 'nbfc'].includes(sectorType)

  const variants = {}

  // ── Sales-based ─────────────────────────────────────────────────────────────
  // Was gating on revenue+marketCap only, but the actual calculation needs
  // evTarget (market cap + net debt), which additionally requires debt AND
  // cash to both be known. When either was missing this rendered as a normal,
  // seemingly-live card with nothing inside it, instead of the same clean N/A
  // treatment the other two variants get when they can't compute.
  if (revenue != null && revenue > 0 && marketCap && evTarget != null) {
    // enterpriseDiscountRate (WACC), not discountRate (Ke) — this variant
    // solves against evTarget, an ENTERPRISE value, see the note above.
    const impliedG = solveImpliedGrowth(revenue, evTarget, terminalSalesMultiple, enterpriseDiscountRate, horizon)
    const sanity   = impliedG != null
      ? buildSanityTable(revenue, evTarget, terminalSalesMultiple, enterpriseDiscountRate, horizon, impliedG)
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
        terminalMultiple: { value: terminalSalesMultiple, rationale: assumptions.rationale.terminalSalesMultiple, tier: assumptions.tiers.terminalSalesMultiple },
        discountRate:     { value: enterpriseDiscountRate, rationale: assumptions.rationale.enterpriseDiscountRate, tier: assumptions.tiers.enterpriseDiscountRate },
        horizon:          { value: horizon,                rationale: assumptions.rationale.horizon }
      }
    }
  } else {
    variants.sales = {
      applicable: false,
      reason: revenue == null ? 'Revenue data not available'
        : !(revenue > 0) ? 'Revenue is zero or negative'
        : !marketCap ? 'Market cap not available'
        : 'Debt and/or cash not available — needed to bridge market cap to enterprise value'
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
        terminalMultiple: { value: terminalPeMultiple, rationale: assumptions.rationale.terminalPeMultiple, tier: assumptions.tiers.terminalPeMultiple },
        discountRate:     { value: discountRate,        rationale: assumptions.rationale.discountRate,       tier: assumptions.tiers.discountRate },
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
  // FCF here is firm-level (opCF - capex, before financing), so it has to be
  // solved against enterprise value (evTarget = marketCap + net debt), the
  // same bridge the Sales variant already uses and for the same reason —
  // equity market cap ignores net debt, which would overstate the implied
  // growth for a levered firm. Comparing firm-level cash flow to a bare
  // equity market cap while calling the multiple "EV/FCF" was a units
  // mismatch: pairing an enterprise-value-denominated multiple with an
  // equity-value target.
  const fcfBase = fcf ?? opCF
  if (fcfBase != null && fcfBase > 0 && evTarget != null) {
    // For FCF we use EV/FCF terminal multiple — typically 15-25×
    // enterpriseDiscountRate (WACC), not discountRate (Ke) — see the note
    // on evTarget above; this variant solves against an ENTERPRISE value.
    const termFcfMult = assumptions.terminalFcfMultiple
    const impliedG = solveImpliedGrowth(fcfBase, evTarget, termFcfMult, enterpriseDiscountRate, horizon)
    const sanity   = impliedG != null
      ? buildSanityTable(fcfBase, evTarget, termFcfMult, enterpriseDiscountRate, horizon, impliedG)
      : null

    variants.fcf = {
      applicable: true,
      label: 'FCF-based',
      note: [
        r?.fcfEstimated && 'FCF estimated as Operating CF − Depreciation (CapEx ≈ Depreciation).',
        r?.cashEstimated && 'Cash not reported — assumed nil.',
        !r?.fcfEstimated && !r?.cashEstimated && 'Uses Free Cash Flow — most precise for cash-generative businesses.',
      ].filter(Boolean).join(' '),
      base: fcfBase,
      baseLabel: r?.fcfEstimated ? 'Free Cash Flow (estimated)' : 'Free Cash Flow',
      terminalMultiple: termFcfMult,
      terminalMultipleLabel: `${termFcfMult}× FCF`,
      impliedGrowth: impliedG,
      sanityTable: sanity,
      conclusion: getConclusion(impliedG, historicalRevGrowth, stage, 'FCF'),
      assumptions: {
        terminalMultiple: { value: termFcfMult, rationale: assumptions.rationale.terminalFcfMultiple, tier: assumptions.tiers.terminalFcfMultiple },
        discountRate:     { value: enterpriseDiscountRate, rationale: assumptions.rationale.enterpriseDiscountRate, tier: assumptions.tiers.enterpriseDiscountRate },
        horizon:          { value: horizon,       rationale: assumptions.rationale.horizon }
      }
    }
  } else {
    variants.fcf = {
      applicable: false,
      reason: (fcf != null && fcf <= 0) || (r?.opCF != null && r.opCF <= 0)
        ? (isFinancial
            ? 'Operating CF is negative — this is structurally normal for banks/insurers (loan disbursements count as operating outflow) and does not indicate financial distress. Use Earnings-based instead.'
            : 'FCF and Operating CF are negative — FCF-based method not applicable')
        : fcfBase == null
        ? 'Free Cash Flow not available (needs CapEx — see the data gaps banner)'
        : 'Debt and/or cash not available — needed to bridge market cap to enterprise value'
    }
  }

  // ── Reverse DCF ──────────────────────────────────────────────────────────────
  // The fourth way of asking the same inverse question ("what does the
  // current price already assume?"), but through the FULL DCF fade-to-
  // terminal-growth mechanics — a genuinely different, also legitimate
  // terminal-value convention from the other three variants' flat-growth-
  // then-exit-multiple approach, kept visibly distinct rather than blended
  // in. Uses THIS panel's own WACC (enterpriseDiscountRate), not the
  // Valuation tab's separate DCF WACC — two different tabs computing WACC
  // independently could disagree for no stated reason, but reverseDcfGrowth
  // solves against targetEV (marketCap + totalDebt - cash, an ENTERPRISE
  // value), so it needs a real WACC, not the pure cost of equity — this used
  // to pass discountRate (Ke) here, the same units mismatch fixed on the
  // Sales/FCF variants above.
  if (fcf > 0 && price > 0 && marketCap && r?.shares && r?.totalDebt != null) {
    // Its own override key (not shared with the other variants' terminal-
    // multiple overrides, which are a different convention) — editable via
    // the same onAssumptionChange mechanism the panel already uses.
    const market = opts.market ?? 'IN'
    const reverseDcfTermGrowth = overrides.reverseDcfTermGrowth ?? (TERMINAL_GROWTH_BY_MARKET[market] ?? TERMINAL_GROWTH_BY_MARKET.IN)
    const impliedG = reverseDcfGrowth(r, { wacc: enterpriseDiscountRate, termGrowth: reverseDcfTermGrowth, projYears: horizon })
    variants.reverseDcf = {
      applicable: impliedG != null,
      label: 'Reverse DCF',
      note: 'Uses the full DCF fade-to-terminal-growth mechanics (perpetuity-growth convention) — unlike the exit-multiple convention the other three variants use, and using this panel\'s own WACC, not the Valuation tab\'s DCF WACC.',
      base: fcf,
      baseLabel: r?.fcfEstimated ? 'Free Cash Flow (estimated)' : 'Free Cash Flow',
      impliedGrowth: impliedG,
      // The exit-multiple sanity table (buildSanityTable/impliedMarketCap)
      // doesn't translate to a perpetuity-growth DCF — skipped rather than
      // force-fitted onto a convention it wasn't built for.
      sanityTable: null,
      conclusion: impliedG != null ? getConclusion(impliedG, historicalRevGrowth, stage, 'FCF') : null,
      assumptions: {
        // termGrowth, not terminalMultiple — this variant has no terminal
        // multiple at all (perpetuity-growth convention, not exit-multiple).
        // VariantBlock renders whichever of the two is present.
        termGrowth:   { value: reverseDcfTermGrowth, rationale: `${(reverseDcfTermGrowth * 100).toFixed(1)}% is the terminal growth rate cash flows fade to once the explicit projection window ends — defaults to the same rate DCF's Fair Value model uses.`, tier: TIER.DERIVED },
        discountRate: { value: enterpriseDiscountRate, rationale: assumptions.rationale.enterpriseDiscountRate, tier: assumptions.tiers.enterpriseDiscountRate },
        horizon:      { value: horizon,      rationale: assumptions.rationale.horizon },
      },
    }
    if (impliedG == null) variants.reverseDcf.reason = 'DCF inputs insufficient to solve (needs positive FCF, a real WACC, and a price above what maximal growth could support).'
  } else {
    variants.reverseDcf = {
      applicable: false,
      reason: !(fcf > 0) ? 'Free Cash Flow not available (needs CapEx — see the data gaps banner)'
        : 'Insufficient data (needs shares outstanding and debt)',
    }
  }

  return { variants, assumptions, marketCap, price }
}