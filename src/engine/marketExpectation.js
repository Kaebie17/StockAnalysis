/**
 * src/engine/marketExpectation.js
 *
 * Implied expectations parsing calculator.
 */

import { SECTOR_TYPES } from './stage.js'

export function getDefaultAssumptions(stage, sectorType, ratios) {
  const terminalSalesMultiple = sectorType === SECTOR_TYPES?.BANK ? 2.0 : 3.0
  const terminalPeMultiple = ratios?.pe?.value && ratios.pe.value < 60 ? Math.round(ratios.pe.value) : 20
  const discountRate = stage === 'GROWTH' ? 0.15 : 0.12

  return {
    terminalSalesMultiple, terminalPeMultiple, discountRate, horizon: 10,
    rationale: { terminalSalesMultiple: 'Terminal Multiple assumption', terminalPeMultiple: 'Terminal P/E Multiple assumption', discountRate: 'Discount baseline requirement.', horizon: 'Standard 10Y horizon.' }
  }
}

function solveImpliedGrowth(baseValue, marketCap, terminalMult, discountRate, horizon) {
  if (!baseValue || !marketCap || baseValue <= 0 || marketCap <= 0 || !terminalMult) return null
  try {
    const g = Math.pow((marketCap * Math.pow(1 + discountRate, horizon)) / (baseValue * terminalMult), 1 / horizon) - 1
    return isFinite(g) ? g * 100 : null
  } catch { return null }
}

export function runMarketExpectation(data, ratioResult, stage, sectorType, overrides = {}) {
  const r = ratioResult || {}
  const defaults = getDefaultAssumptions(stage, sectorType, r?.ratios)
  const assumptions = { ...defaults, ...overrides }
  const { terminalSalesMultiple, terminalPeMultiple, discountRate, horizon } = assumptions

  const marketCap = r?.marketCap || data?.marketCap
  const revenue   = r?.revenue   || data?.revenue
  const netProfit = r?.netProfit || data?.netProfit
  const fcf       = r?.fcf > 0 ? r.fcf : (data?.fcf > 0 ? data.fcf : null)

  const variants = {}

  if (revenue && revenue > 0 && marketCap) {
    variants.sales = {
      applicable: true, label: 'Sales-based', base: revenue, terminalMultiple: terminalSalesMultiple,
      impliedGrowth: solveImpliedGrowth(revenue, marketCap, terminalSalesMultiple, discountRate, horizon),
      conclusion: `Implied market requirement.`
    }
  } else { variants.sales = { applicable: false, reason: 'Missing criteria' } }

  if (netProfit && netProfit > 0 && marketCap) {
    variants.earnings = {
      applicable: true, label: 'Earnings-based', base: netProfit, terminalMultiple: terminalPeMultiple,
      impliedGrowth: solveImpliedGrowth(netProfit, marketCap, terminalPeMultiple, discountRate, horizon),
      conclusion: `Implied forward earnings rate.`
    }
  } else { variants.earnings = { applicable: false, reason: 'Missing criteria' } }

  if (fcf && fcf > 0 && marketCap) {
    variants.fcf = {
      applicable: true, label: 'FCF-based', base: fcf, terminalMultiple: 15,
      impliedGrowth: solveImpliedGrowth(fcf, marketCap, 15, discountRate, horizon),
      conclusion: `Implied corporate free cash generation constraint.`
    }
  } else { variants.fcf = { applicable: false, reason: 'Missing criteria' } }

  return { variants, assumptions, marketCap }
}